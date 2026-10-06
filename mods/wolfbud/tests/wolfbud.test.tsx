import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fitTail, formatSnapshot, tailText, wrappedRows } from '../hooks/activity'

const FROM_COMPOSER = {
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

const HUB_FILE = JSON.stringify({ port: 4747, pid: 9, token: 'service-token', windowKey: 'window-key' })

type Post = { path: string; method: string; body: Record<string, unknown>; key: string }

/**
 * Stands in for the hub beneath the plugin. Health is up unless `healthFails`
 * throws that many times first. Commands and notices wait for the poll, which
 * runs when the test advances the clock.
 */
function fakeHub(on: On, { healthFails = 0 }: { healthFails?: number } = {}) {
  const posts: Post[] = []
  const runs: string[][] = []
  const submitted: string[] = []
  const appended: string[] = []
  const commands: object[] = []
  const notices: object[] = []
  const waiting: Array<{ check: () => boolean; done: () => void }> = []
  let failsLeft = healthFails
  const clock = mock.clock(on, { now: 1_700_000_000_000 })

  const notify = () => {
    for (const one of [...waiting]) {
      if (one.check()) {
        waiting.splice(waiting.indexOf(one), 1)
        one.done()
      }
    }
  }
  const until = (check: () => boolean) => (check() ? Promise.resolve() : new Promise<void>(done => waiting.push({ check, done })))

  on('fs.read', () => ({ value: HUB_FILE }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const key = e.init?.headers?.['x-wolfbud-key'] ?? ''
    posts.push({ path: url.pathname, method: e.init?.method ?? 'GET', body, key })
    notify()
    if (url.pathname === '/api/health') {
      if (failsLeft > 0) {
        failsLeft -= 1
        return { value: { status: 503, ok: false, headers: {}, text: '{}' } }
      }
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ ok: true, hasApiKey: true, isWindowBuilt: true, windows: 0 }),
        },
      }
    }
    if (url.pathname === '/api/window') {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ ok: true, connected: false, opened: true, name: 'shop' }),
        },
      }
    }
    if (url.pathname === '/api/subscribe') {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ token: 'sess-token', name: 'shop', windowOpen: false, hasApiKey: true, isWindowBuilt: true }),
        },
      }
    }
    if (url.pathname.endsWith('/commands')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ commands: commands.splice(0), notices: notices.splice(0) }),
        },
      }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, delivered: true, connected: true, name: 'shop' }) } }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    notify()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.cwd', () => ({ value: '/repo/shop' }))
  on('session.messages', () => ({ value: [] }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    notify()
    return { text: e.text }
  })
  on('session.append', (_$, e) => {
    for (const block of e.message.content) if (block.type === 'text') appended.push(String(block.text))
    notify()
    return { message: e.message, uuid: 'row-1' }
  })

  const postsTo = (path: string) => posts.filter(post => post.path === path || post.path.endsWith(path))

  return { posts, runs, submitted, appended, commands, notices, until, postsTo, clock }
}

/** /wolfbud against a hub that is already up. The poll is armed and not yet run. */
async function startWolfbud($: Engine, hub: ReturnType<typeof fakeHub>) {
  const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })
  await hub.until(() => hub.postsTo('/api/subscribe').length === 1 && hub.postsTo('/api/window').length === 1)
  return answer
}

async function pull(hub: ReturnType<typeof fakeHub>, clock: MockClock) {
  await clock.advance(1)
}

describe('the hub', () => {
  test('/wolfbud subscribes this session and asks the hub to show the one window', async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'el-test', HOME: '/Users/test' })
    const hub = fakeHub(on)

    const answer = await startWolfbud($, hub)

    expect(answer.text).toBe('Opening WolfBud.')
    expect(hub.runs).toEqual([])
    const subscribed = hub.postsTo('/api/subscribe')[0]
    expect(subscribed?.key).toBe('service-token')
    expect(subscribed?.body).toMatchObject({
      project: 'shop',
      cwd: '/repo/shop',
      capabilities: ['submit', 'steer', 'abort', 'snapshot'],
    })
    expect(typeof subscribed?.body.sessionId).toBe('string')
    const shown = hub.postsTo('/api/window')[0]
    expect(shown?.body).toMatchObject({ sessionId: subscribed?.body.sessionId, call: false })
    expect(shown?.key).toBe('service-token')
    expect(hub.posts.some(post => post.key === 'window-key')).toBe(false)
  })

  test('a down hub is started by the launcher, not by spawning the server as a Claude child', async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'el-test', HOME: '/Users/test', WOLFBUD_NODE: '/usr/local/bin/node' })
    const hub = fakeHub(on, { healthFails: 1 })

    const answer = await startWolfbud($, hub)

    expect(answer.text).toBe('Opening WolfBud.')
    expect(hub.runs).toHaveLength(1)
    expect(hub.runs[0]?.[0]).toBe('/usr/local/bin/node')
    expect(hub.runs[0]?.[1]).toMatch(/bridge\/launch\.mjs$/)
    expect(hub.runs[0]?.some(arg => arg.includes('server.mjs'))).toBe(false)
    expect(hub.runs.some(argv => argv.includes('open') || argv[0] === 'orca' || argv[0] === 'terminal-browser')).toBe(false)
  })

  test('/wolfbud call focuses this subscription and asks to start the one call', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)

    const answer = await $.command.run({ command: 'wolfbud', args: 'call', ...FROM_COMPOSER })

    expect(answer.text).toBe('Calling WolfBud, focused on shop.')
    expect(hub.postsTo('/api/window').at(-1)?.body).toMatchObject({ call: true })
  })

  test('/wolfbud end hangs up the call and does not unsubscribe', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const answer = await $.command.run({ command: 'wolfbud', args: 'end', ...FROM_COMPOSER })

    expect(answer.text).toBe('Ending the call.')
    expect(hub.postsTo('/api/call/end')).toHaveLength(1)
    expect(hub.postsTo('/bye')).toHaveLength(0)
  })

  test('/wolfbud stop unsubscribes this session only', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const answer = await $.command.run({ command: 'wolfbud', args: 'stop', ...FROM_COMPOSER })

    expect(answer.text).toBe('This session left WolfBud. Other sessions keep the window.')
    expect(hub.postsTo('/bye')).toHaveLength(1)
    expect(hub.postsTo('/api/call/end')).toHaveLength(0)
  })

  test('the session ending unsubscribes and leaves the call up', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess', resume: { id: 'sess' } })

    expect(hub.postsTo('/bye')).toHaveLength(1)
    expect(hub.postsTo('/api/call/end')).toHaveLength(0)
  })

  test('the api_key option is handed to the launcher when it has to start the hub', { options: { api_key: 'from-option' } }, async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'from-env', HOME: '/Users/test' })
    const hub = fakeHub(on, { healthFails: 1 })

    await startWolfbud($, hub)

    expect(hub.runs[0]?.[1]).toMatch(/launch\.mjs$/)
  })
})

describe('prompts from the agent', () => {
  test('go to Claude as a new prompt while it is idle', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.commands.push({
      id: 'cmd_1',
      type: 'send',
      prompt: 'Rename Submit to Save in the checkout form.',
      when: 'now',
      summary: 'Rename Submit to Save',
    })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    expect(hub.submitted).toHaveLength(1)
    expect(hub.submitted[0]).toContain('Rename Submit to Save in the checkout form.')
    expect(hub.submitted[0]).toContain('WolfBud')
    expect(hub.appended).toHaveLength(0)
    expect(hub.postsTo('/ack')[0]?.body).toEqual({ id: 'cmd_1', ok: true, message: 'Sent: Claude is starting on it now.' })
    const ack = hub.postsTo('/ack')[0]
    expect(ack?.key).not.toBe('service-token')
  })

  // The kit has no store beneath session.append (a hook there can't answer
  // alone), so a plugin's append is refused here: what this pins is that a
  // refused mid-turn note still reaches Claude, queued behind the turn.
  test('a "now" prompt mid-turn that cannot be steered in is queued, not lost', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    await $.turn.start({ text: 'build the checkout form', turnId: 'turn-1' })
    hub.commands.push({ id: 'cmd_2', type: 'send', prompt: 'Use the existing Button component.', when: 'now', summary: 'Use Button' })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    expect(hub.submitted).toHaveLength(1)
    expect(hub.submitted[0]).toContain('Use the existing Button component.')
    expect(hub.postsTo('/ack')[0]?.body).toMatchObject({ id: 'cmd_2', ok: true, message: expect.stringContaining('queued') })
  })

  test('queue behind the running turn when they can wait', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    await $.turn.start({ text: 'build the checkout form', turnId: 'turn-1' })
    hub.commands.push({ id: 'cmd_3', type: 'send', prompt: 'Afterwards, update the README.', when: 'after_current', summary: 'Update README' })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    expect(hub.submitted).toHaveLength(1)
    expect(hub.postsTo('/ack')[0]?.body).toMatchObject({ ok: true, message: expect.stringContaining('Queued') })
  })

  test('a stop with nothing running says so', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.commands.push({ id: 'cmd_4', type: 'stop', reason: 'wrong file' })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    expect(hub.postsTo('/ack')[0]?.body).toEqual({ id: 'cmd_4', ok: false, message: "Claude isn't running anything right now." })
  })

  test('a snapshot command posts this session transcript back', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.commands.push({ id: 'cmd_5', type: 'snapshot' })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    const events = hub.postsTo('/events').at(-1)?.body
    expect(events).toMatchObject({ snapshot: expect.stringContaining('[session snapshot] Session shop.') })
  })
})

describe('activity reports', () => {
  test('a failed Bash call reaches the hub with its error', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    on('tool.call', { tool: 'Bash' }, () => ({
      isError: true as const,
      result: 'exit 1',
      text: 'FAIL src/cart.test.ts\n3 failed, 12 passed',
    }))
    await startWolfbud($, hub)

    await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Run the tests' })

    const events = hub.postsTo('/events').flatMap(post => (post.body.events as unknown[] | undefined) ?? [])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        tool: 'Bash',
        detail: 'Run the tests',
        status: 'error',
        error: 'FAIL src/cart.test.ts 3 failed, 12 passed',
      }),
    )
  })

  test('turns report busy, then the answer', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    await $.turn.start({ text: 'fix the cart', turnId: 'turn-9' })
    await $.turn.complete({ answer: 'Fixed the rounding bug.', durationMs: 4200, isAborted: false, turnId: 'turn-9', reason: 'answer' })

    const kinds = hub.postsTo('/events').flatMap(post => ((post.body.events as Array<{ kind: string }> | undefined) ?? []).map(event => event.kind))
    expect(kinds).toEqual(['turn-start', 'turn-complete'])
  })

  test('nothing is posted before the session is subscribed', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'contents', text: 'contents' }))

    await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })

    expect(hub.posts).toHaveLength(0)
  })
})

const PANE_PROPS = {
  title: 'WolfBud',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

describe('the pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`invites a call before there is one (${surface})`, async ($, on) => {
      mock.env(on, { HOME: '/Users/test' })
      const ui = await $.ui.mount({ plugin: 'wolfbud', surface, component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })

      expect(await ui.find({ key: 'call' })).toBeDefined()
      expect(await ui.find({ key: 'end' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '○ not on a call' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Call WolfBud to talk through/ })).toBeDefined()
      await ui.unmount()
    })

    test(`shows the live call and what went to Claude (${surface})`, async ($, on) => {
      mock.env(on, { HOME: '/Users/test' })
      const hub = fakeHub(on)
      await startWolfbud($, hub)
      hub.notices.push({ t: 'status', call: 'live', mode: 'listening' })
      hub.notices.push({ t: 'line', role: 'user', text: 'can we rename that button?' })
      hub.commands.push({ id: 'cmd_1', type: 'send', prompt: 'Rename Submit to Save.', when: 'after_current', summary: 'Rename Submit to Save' })
      await pull(hub, hub.clock)
      await hub.until(() => hub.postsTo('/ack').length === 1)

      const ui = await $.ui.mount({ plugin: 'wolfbud', surface, component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('● on a call · listening')
      expect(drawn).toContain('can we rename that button?')
      expect(drawn).toContain('Rename Submit to Save')
      expect(drawn).toContain('→ claude')
      expect(drawn).toContain('shop ·')

      await ui.press({ key: 'end' })
      expect(hub.postsTo('/api/call/end').length).toBeGreaterThan(0)
      await ui.unmount()
    })
  }

  test('a long call keeps the newest lines and the buttons in view (terminal)', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.notices.push({ t: 'status', call: 'live', mode: 'listening' })
    for (let i = 1; i <= 12; i += 1) {
      hub.notices.push({
        t: 'line',
        role: i % 2 === 1 ? 'user' : 'agent',
        text: `line ${i}: a sentence long enough to wrap onto a second row of the pane`,
      })
    }
    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/events').length >= 1 || hub.notices.length === 0)

    // The poll consumes notices. Wait until state has the last line by mounting after the clock settles.
    await hub.clock.settle()

    const props = { ...PANE_PROPS, bodyColumns: 48, scroll: { offset: 0, bodyRows: 12 } }
    const ui = await $.ui.mount({ plugin: 'wolfbud', surface: 'terminal', component: 'Pane', requestId: 'wolfbud', props })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('line 12:')
    expect(drawn).toContain('line 10:')
    expect(drawn).not.toContain('line 9:')
    expect(await ui.find({ key: 'end' })).toBeDefined()
    expect(await ui.find({ key: 'window' })).toBeDefined()
    await ui.unmount()
  })
})

describe('helpers', () => {
  test('wrapped rows break between words, and inside a word wider than a row', () => {
    expect(wrappedRows('', 10)).toBe(1)
    expect(wrappedRows('fits in ten', 11)).toBe(1)
    expect(wrappedRows('fits in ten', 10)).toBe(2)
    expect(wrappedRows('one two three four', 9)).toBe(3)
    expect(wrappedRows('abcdefghijklmnopqrstuvwxy', 10)).toBe(3)
    expect(wrappedRows('first\nsecond', 40)).toBe(2)
  })

  test('the transcript keeps the newest lines that fit, and cuts a lone tall one from the front', () => {
    const lines = [1, 2, 3, 4].map(id => ({ id, text: `line ${id} wraps here` }))
    expect(fitTail(lines, 5, 10).map(line => line.id)).toEqual([3, 4])
    expect(fitTail(lines, 100, 10).map(line => line.id)).toEqual([1, 2, 3, 4])
    const [only] = fitTail([{ id: 1, text: 'word '.repeat(40).trim() }], 2, 10)
    expect(only?.text.startsWith('…')).toBe(true)
    expect(wrappedRows(only?.text ?? '', 10)).toBeLessThanOrEqual(2)
    expect(tailText('short', 1, 10)).toBe('short')
  })

  test('the snapshot names the project, the state and the latest exchange', () => {
    const text = formatSnapshot(
      [
        { role: 'user', text: 'Add a dark mode toggle', toolUses: [] },
        {
          role: 'assistant',
          text: 'Adding it to the settings page.',
          toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/src/settings/Page.tsx' }, isError: true }],
        },
      ],
      { project: 'shop', isBusy: true },
    )
    expect(text).toContain('[session snapshot] Project: shop. Claude is working')
    expect(text).toContain('User: Add a dark mode toggle')
    expect(text).toContain('Claude: Adding it to the settings page. [steps: Edit settings/Page.tsx (failed)]')
  })
})
