import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fitTail, formatSnapshot, splitBridgeOutput, tailText, wrappedRows } from '../hooks/activity'

const FROM_COMPOSER = {
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

type Post = { path: string; body: Record<string, unknown> }

/**
 * Stands in for bridge/server.mjs beneath the plugin: `say` writes a
 * `WOLFBUD` line on its stdout, and every POST, spawn and `open` is recorded.
 * Promises from `until` settle as soon as what they wait for has happened.
 */
function fakeBridge(on: On) {
  const spawned: Array<{ argv: readonly string[]; env: Record<string, string> }> = []
  const posts: Post[] = []
  const runs: string[][] = []
  const submitted: string[] = []
  const appended: string[] = []
  const output: string[] = []
  const waiting: Array<{ check: () => boolean; done: () => void }> = []
  let wake: (() => void) | null = null
  let isClosed = false

  const notify = () => {
    for (const one of [...waiting]) {
      if (one.check()) {
        waiting.splice(waiting.indexOf(one), 1)
        one.done()
      }
    }
  }
  const until = (check: () => boolean) =>
    check() ? Promise.resolve() : new Promise<void>(done => waiting.push({ check, done }))

  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, env: { ...e.env } })
    notify()
    while (!isClosed) {
      const text = output.shift()
      if (text !== undefined) {
        yield { stream: 'stdout' as const, text }
        continue
      }
      await new Promise<void>(resolve => {
        wake = resolve
      })
    }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_$, e) => {
    posts.push({ path: new URL(e.url).pathname, body: JSON.parse(e.init?.body ?? '{}') })
    notify()
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    notify()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.clock(on, { now: 1_700_000_000_000 })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.cwd', () => ({ value: '/repo/shop' }))
  on('session.messages', () => ({ value: [] }))
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

  const say = (message: object) => {
    output.push(`WOLFBUD ${JSON.stringify(message)}\n`)
    wake?.()
    wake = null
  }
  const postsTo = (path: string) => posts.filter(post => post.path === path)

  return {
    spawned,
    posts,
    runs,
    submitted,
    appended,
    until,
    say,
    postsTo,
    /** Resolves once every line said so far has been handled: the bridge reads its stdout in order. */
    async settle() {
      const before = postsTo('/api/claude').filter(post => 'snapshot' in post.body).length
      say({ t: 'snapshot' })
      await until(() => postsTo('/api/claude').filter(post => 'snapshot' in post.body).length > before)
    },
    close() {
      isClosed = true
      wake?.()
    },
  }
}

/** /wolfbud with the bridge coming up ready on port 4747. */
async function startWolfbud($: Engine, bridge: ReturnType<typeof fakeBridge>) {
  const answer = await $.command.run({ command: 'wolfbud', args: '', ...FROM_COMPOSER })
  await bridge.until(() => bridge.spawned.length === 1)
  bridge.say({ t: 'ready', port: 4747, hasApiKey: true, hasAgent: true, isWindowBuilt: true })
  await bridge.until(() => bridge.runs.length === 1)
  return answer
}

describe('the bridge', () => {
  test('/wolfbud spawns it with the key, then opens the window once it is ready', async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'el-test', HOME: '/Users/test' })
    const bridge = fakeBridge(on)

    const answer = await startWolfbud($, bridge)

    expect(answer.text).toBe('Starting WolfBud.')
    const spawn = bridge.spawned[0]
    expect(spawn?.argv.at(-1)).toMatch(/bridge\/server\.mjs$/)
    expect(spawn?.env.ELEVENLABS_API_KEY).toBe('el-test')
    expect(spawn?.env.WOLFBUD_PORT).toBe('4747')
    const key = spawn?.env.WOLFBUD_KEY ?? ''
    expect(key.length).toBeGreaterThan(10)

    const opened = bridge.runs[0] ?? []
    expect(opened.slice(0, 3)).toEqual(['open', '-na', 'Google Chrome'])
    expect(opened).toContain(`--app=http://127.0.0.1:4747/#k=${key}`)
    expect(opened).toContain('--user-data-dir=/Users/test/.wolfbud/chrome')

    const session = bridge.postsTo('/api/claude')[0]?.body
    expect(session).toMatchObject({ isClaudeBusy: false })
    bridge.close()
  })

  test('the api_key option wins over the environment', { options: { api_key: 'from-option' } }, async ($, on) => {
    mock.env(on, { ELEVENLABS_API_KEY: 'from-env', HOME: '/Users/test' })
    const bridge = fakeBridge(on)

    await startWolfbud($, bridge)

    expect(bridge.spawned[0]?.env.ELEVENLABS_API_KEY).toBe('from-option')
    bridge.close()
  })
})

describe('prompts from the agent', () => {
  test('go to Claude as a new prompt while it is idle', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)

    bridge.say({ t: 'send', id: 'r1', prompt: 'Rename Submit to Save in the checkout form.', when: 'now', summary: 'Rename Submit to Save' })
    await bridge.until(() => bridge.postsTo('/api/ack').length === 1)

    expect(bridge.submitted).toHaveLength(1)
    expect(bridge.submitted[0]).toContain('Rename Submit to Save in the checkout form.')
    expect(bridge.submitted[0]).toContain('WolfBud')
    expect(bridge.appended).toHaveLength(0)
    expect(bridge.postsTo('/api/ack')[0]?.body).toEqual({ id: 'r1', ok: true, message: 'Sent: Claude is starting on it now.' })
    bridge.close()
  })

  // The kit has no store beneath session.append (a hook there can't answer
  // alone), so a plugin's append is refused here: what this pins is that a
  // refused mid-turn note still reaches Claude, queued behind the turn.
  test('a "now" prompt mid-turn that cannot be steered in is queued, not lost', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)
    await $.turn.start({ text: 'build the checkout form', turnId: 'turn-1' })

    bridge.say({ t: 'send', id: 'r2', prompt: 'Use the existing Button component.', when: 'now', summary: 'Use Button' })
    await bridge.until(() => bridge.postsTo('/api/ack').length === 1)

    expect(bridge.submitted).toHaveLength(1)
    expect(bridge.submitted[0]).toContain('Use the existing Button component.')
    expect(bridge.postsTo('/api/ack')[0]?.body).toMatchObject({ id: 'r2', ok: true, message: expect.stringContaining('queued') })
    bridge.close()
  })

  test('queue behind the running turn when they can wait', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)
    await $.turn.start({ text: 'build the checkout form', turnId: 'turn-1' })

    bridge.say({ t: 'send', id: 'r3', prompt: 'Afterwards, update the README.', when: 'after_current', summary: 'Update README' })
    await bridge.until(() => bridge.postsTo('/api/ack').length === 1)

    expect(bridge.submitted).toHaveLength(1)
    expect(bridge.postsTo('/api/ack')[0]?.body).toMatchObject({ ok: true, message: expect.stringContaining('Queued') })
    bridge.close()
  })

  test('a stop with nothing running says so', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)

    bridge.say({ t: 'stop', id: 's1', reason: 'wrong file' })
    await bridge.until(() => bridge.postsTo('/api/ack').length === 1)

    expect(bridge.postsTo('/api/ack')[0]?.body).toEqual({ id: 's1', ok: false, message: "Claude isn't running anything right now." })
    bridge.close()
  })
})

describe('activity reports', () => {
  test('a failed Bash call reaches the bridge with its error', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    on('tool.call', { tool: 'Bash' }, () => ({ isError: true as const, result: 'exit 1', text: 'FAIL src/cart.test.ts\n3 failed, 12 passed' }))
    await startWolfbud($, bridge)

    await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Run the tests' })

    const events = bridge.postsTo('/api/claude').flatMap(post => (post.body.events as unknown[] | undefined) ?? [])
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool',
      tool: 'Bash',
      detail: 'Run the tests',
      status: 'error',
      error: 'FAIL src/cart.test.ts 3 failed, 12 passed',
    }))
    bridge.close()
  })

  test('turns report busy, then the answer', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)

    await $.turn.start({ text: 'fix the cart', turnId: 'turn-9' })
    await $.turn.complete({ answer: 'Fixed the rounding bug.', durationMs: 4200, isAborted: false, turnId: 'turn-9', reason: 'answer' })

    const kinds = bridge.postsTo('/api/claude').flatMap(post => ((post.body.events as Array<{ kind: string }> | undefined) ?? []).map(event => event.kind))
    expect(kinds).toEqual(['turn-start', 'turn-complete'])
    const done = bridge.postsTo('/api/claude').at(-1)?.body.events
    expect(done).toEqual([expect.objectContaining({ answer: 'Fixed the rounding bug.', reason: 'answer' })])
    bridge.close()
  })

  test('nothing is posted before the bridge is up', async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'contents', text: 'contents' }))

    await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })

    expect(bridge.posts).toHaveLength(0)
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

    // A mount settles while the fake bridge's stream waits for its next line,
    // which costs the kit about a second and a half per act: hence the timeout.
    test(`shows the live call and what went to Claude (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
      mock.env(on, { HOME: '/Users/test' })
      const bridge = fakeBridge(on)
      await startWolfbud($, bridge)
      bridge.say({ t: 'window', open: true, count: 1 })
      bridge.say({ t: 'status', call: 'live', mode: 'listening' })
      bridge.say({ t: 'line', role: 'user', text: 'can we rename that button?' })
      bridge.say({ t: 'send', id: 'r1', prompt: 'Rename Submit to Save.', when: 'after_current', summary: 'Rename Submit to Save' })
      await bridge.until(() => bridge.postsTo('/api/ack').length === 1)
      await bridge.settle()

      const ui = await $.ui.mount({ plugin: 'wolfbud', surface, component: 'Pane', requestId: 'wolfbud', props: PANE_PROPS })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('● on a call · listening')
      expect(drawn).toContain('can we rename that button?')
      expect(drawn).toContain('Rename Submit to Save')
      expect(drawn).toContain('→ claude')

      // Mid-call, Window must not open a second window (it would take the call over).
      const opened = bridge.runs.length
      await ui.press({ key: 'window' })
      expect(bridge.runs.length).toBe(opened)

      await ui.press({ key: 'end' })
      expect(bridge.postsTo('/api/command').at(-1)?.body).toEqual({ cmd: 'end-call' })
      bridge.close()
      await ui.unmount()
    })
  }

  test('a long call keeps the newest lines and the buttons in view (terminal)', { timeoutMs: 20_000 }, async ($, on) => {
    mock.env(on, { HOME: '/Users/test' })
    const bridge = fakeBridge(on)
    await startWolfbud($, bridge)
    bridge.say({ t: 'status', call: 'live', mode: 'listening' })
    for (let i = 1; i <= 12; i += 1) {
      bridge.say({ t: 'line', role: i % 2 === 1 ? 'user' : 'agent', text: `line ${i}: a sentence long enough to wrap onto a second row of the pane` })
    }
    await bridge.settle()

    // 12 rows: 5 for the header, margins and buttons, 7 for lines of 2 rows each at 39 cells.
    const props = { ...PANE_PROPS, bodyColumns: 48, scroll: { offset: 0, bodyRows: 12 } }
    const ui = await $.ui.mount({ plugin: 'wolfbud', surface: 'terminal', component: 'Pane', requestId: 'wolfbud', props })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('line 12:')
    expect(drawn).toContain('line 10:')
    expect(drawn).not.toContain('line 9:')
    expect(await ui.find({ key: 'end' })).toBeDefined()
    expect(await ui.find({ key: 'window' })).toBeDefined()
    bridge.close()
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

  test('bridge output splits on WOLFBUD lines and keeps a partial tail', () => {
    const { messages, rest } = splitBridgeOutput('noise\nWOLFBUD {"t":"window","open":true,"count":1}\nWOLFBUD {"t":"li')
    expect(messages).toEqual([{ t: 'window', open: true, count: 1 }])
    expect(rest).toBe('WOLFBUD {"t":"li')
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
