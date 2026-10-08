import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fitTail, formatSnapshot, tailText, wrappedRows } from '../hooks/activity'
import type { HubCall, HubCommand, HubLine } from '../hooks/events'

const FROM_COMPOSER = {
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

const HUB_FILE = JSON.stringify({ port: 4747, token: 'service-token', windowKey: 'window-key' })
const IDLE: HubCall = { status: 'idle', mode: null, error: null }

type Post = { path: string; method: string; body: Record<string, unknown>; key: string }

/** A hub answer as `$.http.fetch` hands it over. */
const json = (body: object, status = 200) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })

/**
 * Stands in for the hub beneath the plugin. Health is up unless `healthFails`
 * throws that many times first. Commands and lines wait for the poll, which
 * runs when the test advances the clock; `call` rides on every pull.
 */
function fakeHub(
  on: On,
  {
    healthFails = 0,
    hubFile = HUB_FILE,
    subscribeStatus = 200,
    appendRefusal = null,
  }: { healthFails?: number; hubFile?: string | null; subscribeStatus?: number; appendRefusal?: string | null } = {},
) {
  const posts: Post[] = []
  const runs: string[][] = []
  const submitted: string[] = []
  const appended: string[] = []
  const commands: HubCommand[] = []
  const lines: HubLine[] = []
  const waiting: Array<{ check: () => boolean; done: () => void }> = []
  let failsLeft = healthFails
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const state = { call: IDLE }

  const notify = () => {
    for (const one of [...waiting]) {
      if (one.check()) {
        waiting.splice(waiting.indexOf(one), 1)
        one.done()
      }
    }
  }
  const until = (check: () => boolean) => (check() ? Promise.resolve() : new Promise<void>(done => waiting.push({ check, done })))

  on('fs.read', () => (hubFile === null ? { deny: 'ENOENT: no such file' } : { value: hubFile }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const key = e.init?.headers?.['x-wolfbud-key'] ?? e.init?.headers?.['x-wolfbud-session'] ?? ''
    posts.push({ path: url.pathname, method: e.init?.method ?? 'GET', body, key })
    notify()
    switch (url.pathname) {
      case '/api/health':
        if (failsLeft > 0) {
          failsLeft -= 1
          return json({}, 503)
        }
        return json({ ok: true, hasApiKey: true, isWindowBuilt: true, windows: 0 })
      case '/api/subscribe':
        if (subscribeStatus !== 200) return json({ error: 'bad key' }, subscribeStatus)
        return json({ token: 'sess-token', name: 'shop', hasApiKey: true, isWindowBuilt: true, windows: 0 })
      case '/api/session/window':
        return json({ ok: true, connected: false })
      case '/api/session/commands':
        return json({ commands: commands.splice(0), lines: lines.splice(0), call: state.call, isWindowOpen: true })
      default:
        return json({ ok: true, delivered: true })
    }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    notify()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const panes = new Set<string>()
  const statuses: Array<string | undefined> = []
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: 'WolfBud', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo/shop' }))
  on('session.messages', () => ({ value: [] }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    notify()
    return { text: e.text }
  })
  // Passes the row on so the engine keeps it, or refuses the plugin's own note.
  on('session.append', (_$, e, next) => {
    if (appendRefusal !== null) return { deny: appendRefusal }
    for (const block of e.message.content) if (block.type === 'text') appended.push(String(block.text))
    notify()
    return next(e)
  })

  const postsTo = (path: string) => posts.filter(post => post.path === path || post.path.endsWith(path))
  /** Events reach the hub once the hook that saw them has returned: after the clock settles. */
  const reported = async () => {
    await clock.settle()
    return postsTo('/events').flatMap(post => (post.body.events as Array<Record<string, unknown>> | undefined) ?? [])
  }

  return { posts, runs, submitted, appended, commands, lines, state, until, postsTo, reported, clock, panes, statuses, toasts }
}

type Hub = ReturnType<typeof fakeHub>

/** /wolfbud against a hub that is already up. The poll is armed and not yet run. */
async function startWolfbud($: Engine, hub: Hub) {
  const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })
  await hub.until(() => hub.postsTo('/api/subscribe').length === 1 && hub.postsTo('/api/session/window').length === 1)
  return answer
}

async function pull(hub: Hub, clock: MockClock) {
  await clock.advance(1)
}

describe('a remote session', () => {
  test('reaches the hub through the tunnel, says so, and tells the roster where it runs', async ($, on) => {
    mock.env(on, { HOME: '/home/dev', SSH_CONNECTION: '10.0.0.5 50000 10.0.0.9 22', HOSTNAME: 'sandbox-7' })
    const hub = fakeHub(on)

    const answer = await startWolfbud($, hub)

    expect(answer.text).toBe('Opening WolfBud.')
    expect(hub.runs).toEqual([])
    expect(hub.postsTo('/api/subscribe')[0]?.body).toMatchObject({ isRemote: true, host: 'sandbox-7' })
    const status = await $.command.run({ command: 'wolfbud', args: 'status', ...FROM_COMPOSER })
    expect(status.text).toContain('remote session: through the tunnel to your machine')
  })

  test('never launches a hub of its own, and says plainly how to reach the one on your machine', async ($, on) => {
    mock.env(on, { HOME: '/home/dev', WOLFBUD_REMOTE: '1' })
    const hub = fakeHub(on, { healthFails: 1_000 })

    const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })

    expect(hub.runs).toEqual([])
    expect(hub.postsTo('/api/subscribe')).toHaveLength(0)
    expect(answer.text).toContain("Can't reach the WolfBud hub from this remote session")
    expect(answer.text).toContain('ssh -R 4747:127.0.0.1:4747')
    expect(hub.toasts).toHaveLength(1)
    await $.command.run({ command: 'wolfbud', args: 'hide', ...FROM_COMPOSER })
    expect(hub.statuses.at(-1)).toBe("WolfBud ✕ can't reach your machine's hub · /wolfbud status")

    // The retry loop finds the same problem: no second toast.
    await hub.clock.advance(2_000)
    await hub.clock.advance(2_000)
    expect(hub.toasts).toHaveLength(1)
  })

  test('with the tunnel up but no hub token, says to copy it', async ($, on) => {
    mock.env(on, { HOME: '/home/dev', WOLFBUD_REMOTE: '1' })
    fakeHub(on, { hubFile: null })

    const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })

    expect(answer.text).toContain('this machine has no hub token')
    expect(answer.text).toContain("jq '{token}' ~/.wolfbud/hub.json")
  })

  test('a token the hub refuses is named as the problem', async ($, on) => {
    mock.env(on, { HOME: '/home/dev', WOLFBUD_REMOTE: '1' })
    fakeHub(on, { subscribeStatus: 401 })

    const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })

    expect(answer.text).toContain('The hub refused the token')
  })

  test('WOLFBUD_REMOTE=0 overrides an SSH login: the session is local and may launch the hub', async ($, on) => {
    mock.env(on, { HOME: '/Users/test', SSH_CONNECTION: '10.0.0.5 50000 10.0.0.9 22', WOLFBUD_REMOTE: '0' })
    const hub = fakeHub(on, { healthFails: 1 })

    await startWolfbud($, hub)

    expect(hub.runs).toHaveLength(1)
    expect(hub.postsTo('/api/subscribe')[0]?.body).toMatchObject({ isRemote: false, host: '' })
  })
})

describe('the hub', () => {
  test('/wolfbud subscribes this session and asks the hub to show the one window', async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'el-test', HOME: '/Users/test' })
    const hub = fakeHub(on)

    const answer = await startWolfbud($, hub)

    expect(answer.text).toBe('Opening WolfBud.')
    expect(hub.runs).toEqual([])
    const subscribed = hub.postsTo('/api/subscribe')[0]
    expect(subscribed?.key).toBe('service-token')
    expect(subscribed?.body).toMatchObject({ project: 'shop', apiKey: 'el-test' })
    expect(typeof subscribed?.body.sessionId).toBe('string')
    const shown = hub.postsTo('/api/session/window')[0]
    expect(shown?.body).toEqual({ call: false })
    expect(shown?.key).toBe('sess-token')
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

  test('a second /wolfbud only raises the window; it does not subscribe again', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const answer = await $.command.run({ command: 'wolfbud', args: 'window', ...FROM_COMPOSER })

    expect(answer.text).toBe('Opening WolfBud.')
    expect(hub.postsTo('/api/subscribe')).toHaveLength(1)
    expect(hub.postsTo('/api/health')).toHaveLength(1)
    expect(hub.postsTo('/api/session/window')).toHaveLength(2)
  })

  test('/wolfbud call focuses this subscription and asks to start the one call', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)

    const answer = await $.command.run({ command: 'wolfbud', args: 'call', ...FROM_COMPOSER })

    expect(answer.text).toBe('Calling WolfBud, focused on shop.')
    expect(hub.postsTo('/api/session/window').at(-1)?.body).toEqual({ call: true })
  })

  test('/wolfbud end hangs up the call and does not unsubscribe', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const answer = await $.command.run({ command: 'wolfbud', args: 'end', ...FROM_COMPOSER })

    expect(answer.text).toBe('Ending the call.')
    expect(hub.postsTo('/api/session/call/end')).toHaveLength(1)
    expect(hub.postsTo('/bye')).toHaveLength(0)
  })

  test('/wolfbud hide folds the pane into one status line, and /wolfbud unfolds it', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    expect(hub.statuses.at(-1)).toBeUndefined()

    const answer = await $.command.run({ command: 'wolfbud', args: 'hide', ...FROM_COMPOSER })

    expect(answer.text).toBe('WolfBud folded into the status line. /wolfbud brings the pane back.')
    expect(hub.panes.has('wolfbud')).toBe(false)
    expect(hub.statuses.at(-1)).toBe('WolfBud ○ not on a call · shop · Claude is idle · /wolfbud to expand')
    expect(hub.postsTo('/bye')).toHaveLength(0)

    hub.state.call = { status: 'live', mode: 'listening', error: null }
    await pull(hub, hub.clock)
    await hub.clock.settle()
    expect(hub.statuses.at(-1)).toBe('WolfBud ● on a call · listening · shop · Claude is idle · /wolfbud to expand')

    await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })
    expect(hub.panes.has('wolfbud')).toBe(true)
    expect(hub.statuses.at(-1)).toBeUndefined()
  })

  test('/wolfbud stop unsubscribes this session only', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const answer = await $.command.run({ command: 'wolfbud', args: 'stop', ...FROM_COMPOSER })

    expect(answer.text).toBe('This session left WolfBud. Other sessions keep the window.')
    expect(hub.postsTo('/bye')).toHaveLength(1)
    expect(hub.postsTo('/api/session/call/end')).toHaveLength(0)
  })

  test('the session ending unsubscribes and leaves the call up', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess', resume: { id: 'sess' } })

    expect(hub.postsTo('/bye')).toHaveLength(1)
    expect(hub.postsTo('/api/session/call/end')).toHaveLength(0)
  })

  test(
    'the api_key option travels with the subscription, ahead of the environment',
    { options: { api_key: 'from-option' } },
    async ($, on) => {
      mock.env(on, { ELEVENLABS_API_KEY: 'from-env', HOME: '/Users/test' })
      const hub = fakeHub(on)

      await startWolfbud($, hub)

      expect(hub.postsTo('/api/subscribe')[0]?.body).toMatchObject({ apiKey: 'from-option' })
    },
  )
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
    expect(hub.postsTo('/ack')[0]?.key).toBe('sess-token')
  })

  test('a "now" prompt mid-turn is steered into the running turn', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    await $.turn.start({ text: 'build the checkout form', turnId: 'turn-1' })
    hub.commands.push({ id: 'cmd_2', type: 'send', prompt: 'Use the existing Button component.', when: 'now', summary: 'Use Button' })

    await pull(hub, hub.clock)
    await hub.until(() => hub.postsTo('/ack').length === 1)

    expect(hub.appended).toHaveLength(1)
    expect(hub.appended[0]).toContain('Use the existing Button component.')
    expect(hub.appended[0]).toContain('take this into account from your next step')
    expect(hub.submitted).toHaveLength(0)
    expect(hub.postsTo('/ack')[0]?.body).toMatchObject({ id: 'cmd_2', ok: true, message: expect.stringContaining('Delivered mid-task') })
  })

  // A plugin above may refuse the note. What this pins: a refused mid-turn
  // note still reaches Claude, queued behind the turn, and the ack says so.
  test('a "now" prompt mid-turn that cannot be steered in is queued, not lost', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on, { appendRefusal: 'notes are off in this session' })
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
    hub.commands.push({
      id: 'cmd_3',
      type: 'send',
      prompt: 'Afterwards, update the README.',
      when: 'after_current',
      summary: 'Update README',
    })

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
    await hub.until(() => hub.postsTo('/events').some(post => typeof post.body.snapshot === 'string'))

    const events = hub.postsTo('/events').at(-1)?.body
    expect(events).toMatchObject({ snapshot: expect.stringContaining('[session snapshot] Session shop.') })
    expect(hub.postsTo('/ack')).toHaveLength(0)
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

    expect(await hub.reported()).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        tool: 'Bash',
        detail: 'Run the tests',
        status: 'error',
        error: 'FAIL src/cart.test.ts 3 failed, 12 passed',
      }),
    )
  })

  test('turns report busy, then the answer, in one post per burst', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    await $.turn.start({ text: 'fix the cart', turnId: 'turn-9' })
    await $.turn.complete({ answer: 'Fixed the rounding bug.', durationMs: 4200, isAborted: false, turnId: 'turn-9', reason: 'answer' })

    const events = await hub.reported()
    expect(events.map(event => event.kind)).toEqual(['turn-start', 'turn-complete'])
    expect(hub.postsTo('/events')).toHaveLength(1)
    expect(hub.postsTo('/events')[0]?.body).not.toHaveProperty('isClaudeBusy')
  })

  test('nothing is posted before the session is subscribed', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'contents', text: 'contents' }))

    await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
    await hub.clock.settle()

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
      hub.state.call = { status: 'live', mode: 'listening', error: null }
      hub.lines.push({ role: 'user', text: 'can we rename that button?' })
      hub.commands.push({
        id: 'cmd_1',
        type: 'send',
        prompt: 'Rename Submit to Save.',
        when: 'after_current',
        summary: 'Rename Submit to Save',
      })
      await pull(hub, hub.clock)
      await hub.until(() => hub.postsTo('/ack').length === 1)

      const ui = await $.ui.mount({ plugin: 'wolfbud', surface, component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('● on a call · listening')
      expect(drawn).toContain('Call started')
      expect(drawn).toContain('can we rename that button?')
      expect(drawn).toContain('Rename Submit to Save')
      expect(drawn).toContain('→ claude')
      expect(drawn).toContain('shop ·')

      await ui.press({ key: 'end' })
      expect(hub.postsTo('/api/session/call/end').length).toBeGreaterThan(0)
      await ui.unmount()
    })
  }

  test('the Hide button closes the pane and leaves the status line', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)

    const ui = await $.ui.mount({ plugin: 'wolfbud', surface: 'terminal', component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })
    await ui.press({ key: 'hide' })
    await hub.clock.settle()

    expect(hub.panes.has('wolfbud')).toBe(false)
    expect(hub.statuses.at(-1)).toContain('WolfBud ○ not on a call')
    await ui.unmount()
  })

  test('a call state that has not changed adds no line on the next pull', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.state.call = { status: 'live', mode: 'listening', error: null }
    await pull(hub, hub.clock)
    await pull(hub, hub.clock)
    await pull(hub, hub.clock)

    const ui = await $.ui.mount({ plugin: 'wolfbud', surface: 'terminal', component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.split('Call started')).toHaveLength(2)
    await ui.unmount()
  })

  test('a long call keeps the newest lines and the buttons in view (terminal)', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const hub = fakeHub(on)
    await startWolfbud($, hub)
    hub.state.call = { status: 'live', mode: 'listening', error: null }
    for (let i = 1; i <= 12; i += 1) {
      hub.lines.push({
        role: i % 2 === 1 ? 'user' : 'agent',
        text: `line ${i}: a sentence long enough to wrap onto a second row of the pane`,
      })
    }
    await pull(hub, hub.clock)
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
