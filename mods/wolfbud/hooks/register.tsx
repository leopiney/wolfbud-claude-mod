// WolfBud: a voice coworker beside the Claude Code session.
//
// The hooks here watch the session (prompts, tool calls, turns, permission
// notices) and stream it to a local bridge (bridge/server.mjs) the mod
// spawns. The bridge serves a small browser window: the 3D wolf and an
// ElevenLabs voice agent that hears all of it as context. When the user and
// the agent agree on something, the agent's tool call comes back through the
// bridge and lands in Claude's chat: a new prompt when Claude is idle, a note
// into the running turn when it should change course now, or a queued prompt.
// The pane shows the call and everything sent to Claude.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { WolfbudBridge, WolfbudCall, WolfbudLine } from '../types'
import { clip, describeTool, errorGist, fitTail, formatSnapshot, projectName, splitBridgeOutput, toolLabel, wrappedRows } from './activity'
import type { BridgeMessage, ClaudeEvent, WindowCommand } from './events'

const PANE = 'wolfbud'
const DEFAULT_PORT = 4747
const MAX_LINES = 80
// The pane's rows besides the transcript: the call line, Claude's line, the two
// margins and the buttons. A transcript line's text starts after its 8-cell
// label and a 1-cell gap.
const PANE_CHROME_ROWS = 5
const LINE_INDENT = 9
const ORCA_CLIS = ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']
const USAGE = 'Usage: /wolfbud [call | end | window | stop | status]'
const LEAD = 'The user asked WolfBud, the voice assistant on a call beside this session, to pass this on:'

type Browser = 'chrome-app' | 'orca-browser' | 'terminal-browser' | 'default'
type Settings = { apiKey: string; port: number; browser: Browser }
type BridgeStream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
type SendRequest = Extract<BridgeMessage, { t: 'send' }>
type StopRequest = Extract<BridgeMessage, { t: 'stop' }>

const IDLE_CALL: WolfbudCall = { status: 'idle', mode: null, error: null }

const bridge = atom({ plugin: 'wolfbud', key: 'bridge' } as const, {
  status: 'off',
  port: 0,
  key: '',
  error: null,
  hasApiKey: false,
  hasAgent: false,
  isWindowBuilt: false,
  isWindowOpen: false,
  isWanted: false,
  run: '',
})
const call = atom({ plugin: 'wolfbud', key: 'call' } as const, IDLE_CALL)
const lines = atom({ plugin: 'wolfbud', key: 'lines' } as const, [])
const claude = atom({ plugin: 'wolfbud', key: 'claude' } as const, { isBusy: false, turnId: null })

// Module variables reset on a reload, and so does the bridge (the engine
// kills a module's children with it). What must survive lives in $.state.
let settings: Settings = { apiKey: '', port: DEFAULT_PORT, browser: 'chrome-app' }
/** The running bridge's output stream; ending it kills the bridge. */
let child: BridgeStream | null = null
/** Open the window (and maybe start a call) once the bridge says it's ready. */
let pendingWindow: { withCall: boolean } | null = null

function readBrowser(value: unknown): Browser | null {
  return value === 'default' || value === 'terminal-browser' || value === 'orca-browser' || value === 'chrome-app' ? value : null
}

function readSettings(options: PluginOptions): Settings {
  const port = Number(options.port)
  return {
    apiKey: typeof options.api_key === 'string' ? options.api_key.trim() : '',
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    browser: readBrowser(options.browser) ?? 'chrome-app',
  }
}

async function patchBridge($: EngineInterface, patch: Partial<WolfbudBridge>): Promise<void> {
  await update($, bridge, current => ({ ...current, ...patch }))
}

async function addLine($: EngineInterface, role: WolfbudLine['role'], text: string): Promise<void> {
  await update($, lines, list => [...list, { id: (list.at(-1)?.id ?? 0) + 1, role, text }].slice(-MAX_LINES))
}

/** POSTs to the bridge; false when it isn't up or didn't take it. Never throws. */
async function post($: EngineInterface, path: string, body: unknown): Promise<boolean> {
  const current = await read($, bridge)
  if (current.status !== 'ready') return false
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wolfbud-key': current.key },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

async function report($: EngineInterface, event: ClaudeEvent): Promise<void> {
  await post($, '/api/claude', { events: [event] })
}

async function tell($: EngineInterface, cmd: WindowCommand): Promise<boolean> {
  return post($, '/api/command', { cmd })
}

async function startBridge($: EngineInterface): Promise<void> {
  if (child !== null) return
  const current = await read($, bridge)
  const key = current.key || crypto.randomUUID()
  const run = crypto.randomUUID()
  const apiKey = settings.apiKey || (await $.env.get('ELEVENLABS_API_KEY')) || ''
  const agentId = (await $.env.get('WOLFBUD_AGENT_ID')) || ''
  const node = (await $.env.get('WOLFBUD_NODE')) || 'node'

  const env: Record<string, string> = { WOLFBUD_KEY: key, WOLFBUD_PORT: String(current.port || settings.port) }
  if (apiKey) env.ELEVENLABS_API_KEY = apiKey
  if (agentId) env.WOLFBUD_AGENT_ID = agentId

  await patchBridge($, { status: 'starting', key, run, error: null, isWanted: true })
  const stream = $.process.spawn({ argv: [node, `${$.plugin.root}/bridge/server.mjs`], env })
  child = stream
  void pump($, stream, run)
}

/** Reads the bridge for its whole life; the loop ending is the bridge ending. */
async function pump($: EngineInterface, stream: BridgeStream, run: string): Promise<void> {
  let rest = ''
  let error: string | null = null
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stderr') {
        $.ui.log(chunk.text.trimEnd(), { to: 'debug' })
        continue
      }
      const split = splitBridgeOutput(rest + chunk.text)
      rest = split.rest
      for (const message of split.messages) await onBridgeMessage($, message)
    }
    const ended = await stream.result
    if (ended.code !== 0 && ended.code !== null) error = `the bridge exited with code ${ended.code}`
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  if (child === stream) child = null
  try {
    // A newer run (after a reload or a restart) owns the state now.
    const last = await read($, bridge)
    if (last.run !== run) return
    await patchBridge($, {
      status: error !== null || last.status === 'error' ? 'error' : 'off',
      error: error ?? last.error,
      isWindowOpen: false,
    })
    await update($, call, () => IDLE_CALL)
  } catch {
    // The module unloaded with the bridge: its state belongs to the next load.
  }
}

async function stopBridge($: EngineInterface): Promise<void> {
  await tell($, 'end-call')
  await post($, '/api/quit', {})
  await patchBridge($, { isWanted: false })
  const running = child
  child = null
  await running?.return(undefined as never).catch(() => undefined)
}

async function onBridgeMessage($: EngineInterface, message: BridgeMessage): Promise<void> {
  switch (message.t) {
    case 'ready': {
      await patchBridge($, {
        status: 'ready',
        port: message.port,
        error: null,
        hasApiKey: message.hasApiKey,
        hasAgent: message.hasAgent,
        isWindowBuilt: message.isWindowBuilt,
      })
      const cwd = await $.session.cwd()
      const { isBusy } = await read($, claude)
      await post($, '/api/claude', { session: { project: projectName(cwd), cwd }, isClaudeBusy: isBusy })
      const wanted = pendingWindow
      pendingWindow = null
      if (wanted !== null) await openWindow($, wanted.withCall)
      return
    }
    case 'fatal':
      await patchBridge($, { status: 'error', error: message.error })
      return
    case 'window':
      await patchBridge($, { isWindowOpen: message.open })
      if (!message.open) await update($, call, () => IDLE_CALL)
      return
    case 'status': {
      const before = await read($, call)
      await update($, call, () => ({ status: message.call, mode: message.mode, error: message.error ?? null }))
      if (message.call === 'live' && before.status !== 'live') await addLine($, 'note', 'Call started')
      if (message.call !== 'live' && before.status === 'live') await addLine($, 'note', 'Call ended')
      if (message.call === 'error' && message.error) await addLine($, 'note', message.error)
      return
    }
    case 'line':
      await addLine($, message.role, message.text)
      return
    case 'snapshot':
      await sendSnapshot($)
      return
    case 'send':
      await deliver($, message)
      return
    case 'stop':
      await stopClaude($, message)
      return
  }
}

async function sendSnapshot($: EngineInterface): Promise<void> {
  const found = await $.session.messages()
  const messages = Array.isArray(found) ? found : []
  const project = projectName(await $.session.cwd())
  const { isBusy } = await read($, claude)
  await post($, '/api/claude', { snapshot: formatSnapshot(messages, { project, isBusy }) })
}

/** The agent's prompt for Claude: started, steered into the running turn, or queued. */
async function deliver($: EngineInterface, request: SendRequest): Promise<void> {
  const prompt = request.prompt.trim()
  if (prompt === '') {
    await post($, '/api/ack', { id: request.id, ok: false, message: 'The prompt was empty, so nothing was sent.' })
    return
  }
  const { isBusy } = await read($, claude)
  let message: string | null = null

  if (isBusy && request.when === 'now') {
    // Joins the running turn: the model reads it at its loop's next top.
    const note = `${LEAD}\n\n${prompt}\n\n(You are mid-task: take this into account from your next step.)`
    const stored = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (stored.deny === undefined) {
      message = 'Delivered mid-task: Claude will read it at its next step.'
    } else {
      $.ui.log(`wolfbud: mid-turn note refused (${stored.deny}); queued instead`, { to: 'debug' })
    }
  }
  if (message === null) {
    // Resolves only once its turn starts, which may be after the current one,
    // so the ack can't wait for it.
    void $.prompt.submit({ text: `${LEAD}\n\n${prompt}` }).catch((error: unknown) => {
      void addLine($, 'note', `Claude Code didn't take the prompt: ${error instanceof Error ? error.message : String(error)}`)
    })
    message = !isBusy
      ? 'Sent: Claude is starting on it now.'
      : request.when === 'now'
        ? "Couldn't reach Claude mid-task, so it's queued: Claude starts on it as soon as it finishes the current task."
        : 'Queued: Claude will start on it as soon as it finishes the current task.'
  }

  await addLine($, 'sent', request.summary.trim() || clip(prompt, 140))
  await post($, '/api/ack', { id: request.id, ok: true, message })
}

async function stopClaude($: EngineInterface, request: StopRequest): Promise<void> {
  const { isBusy, turnId } = await read($, claude)
  if (!isBusy || turnId === null) {
    await post($, '/api/ack', { id: request.id, ok: false, message: "Claude isn't running anything right now." })
    return
  }
  try {
    await $.turn.abort({ turnId })
    await addLine($, 'note', `Stopped Claude${request.reason ? `: ${request.reason}` : ''}`)
    await post($, '/api/ack', { id: request.id, ok: true, message: 'Stopped Claude.' })
  } catch (error) {
    await post($, '/api/ack', {
      id: request.id,
      ok: false,
      message: `Couldn't stop Claude: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

async function openWindow($: EngineInterface, withCall: boolean): Promise<void> {
  const current = await read($, bridge)
  const url = `http://127.0.0.1:${current.port}/#k=${current.key}${withCall ? '&call=1' : ''}`
  // WOLFBUD_BROWSER wins over the option: a --plugin-dir session has no stored options.
  const browser = readBrowser(await $.env.get('WOLFBUD_BROWSER')) ?? settings.browser
  if (browser === 'orca-browser') {
    // Orca sets ORCA_WORKTREE_ID in the terminals it manages; without it this session
    // isn't in Orca and `orca tab create` has no worktree to open the tab in.
    if (!(await $.env.get('ORCA_WORKTREE_ID'))) {
      $.ui.toast('WolfBud: this session is not running in Orca (no ORCA_WORKTREE_ID); using a Chrome window')
    } else {
      // A tab in Orca's built-in browser, in this session's worktree. The CLI on PATH
      // can be a dead symlink (/usr/local/bin/orca), so the bundled binary is the second try.
      for (const orca of ORCA_CLIS) {
        const opened = await $.process.run([orca, 'tab', 'create', '--url', url, '--json'], { timeoutMs: 20_000 }).catch(() => null)
        if (opened?.exitCode === 0) return
      }
      $.ui.toast("WolfBud: Orca's browser did not open; using a Chrome window")
    }
  }
  if (browser === 'terminal-browser') {
    // A split pane in this terminal tab (or a tab in the browser already there).
    // Without a TTY, new-tab opens the split itself.
    const opened = await $.process.run(['terminal-browser', 'new-tab', url], { timeoutMs: 20_000 }).catch(() => null)
    if (opened?.exitCode === 0) return
    $.ui.toast('WolfBud: terminal-browser did not open (installed? https://terminal-browser.sh); using a Chrome window')
  }
  if (browser !== 'default') {
    // Its own profile: an app window, a mic grant that sticks, and an autoplay
    // policy that lets a call start from the pane without a click in the window.
    const home = (await $.env.get('HOME')) ?? ''
    const opened = await $.process
      .run([
        'open',
        '-na',
        'Google Chrome',
        '--args',
        `--user-data-dir=${home}/.wolfbud/chrome`,
        `--app=${url}`,
        '--window-size=400,680',
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run',
        '--no-default-browser-check',
      ])
      .catch(() => null)
    if (opened?.exitCode === 0) return
  }
  for (const opener of ['open', 'xdg-open']) {
    const opened = await $.process.run([opener, url]).catch(() => null)
    if (opened?.exitCode === 0) return
  }
  $.ui.toast('WolfBud: could not open a browser window')
}

/** Brings up the bridge if needed, then the window; with a call, starts it too. */
async function showWindow($: EngineInterface, withCall: boolean): Promise<string> {
  const current = await read($, bridge)
  if (current.status === 'ready') {
    if (current.isWindowOpen) {
      if (withCall) await tell($, 'start-call')
      return withCall ? 'Calling WolfBud.' : "WolfBud's window is already open."
    }
    await openWindow($, withCall)
    return withCall ? 'Opening WolfBud and calling.' : "Opening WolfBud's window."
  }
  pendingWindow = { withCall }
  await startBridge($)
  return 'Starting WolfBud.'
}

/** The pane's Window button: a fresh window comes to the front (the bridge retires the old one), unless a call holds it. */
async function raiseWindow($: EngineInterface): Promise<void> {
  const current = await read($, bridge)
  const { status } = await read($, call)
  if (current.status !== 'ready') {
    $.ui.toast(await showWindow($, false))
    return
  }
  if (current.isWindowOpen && (status === 'live' || status === 'connecting')) {
    $.ui.toast("WolfBud's window is open, on a call.")
    return
  }
  await openWindow($, false)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'WolfBud' })
}

async function statusText($: EngineInterface): Promise<string> {
  const b = await read($, bridge)
  const c = await read($, call)
  const bridgeLine = b.status === 'ready' ? `bridge on http://127.0.0.1:${b.port}` : `bridge ${b.status}${b.error ? ` (${b.error})` : ''}`
  return [
    `WolfBud: ${bridgeLine}, window ${b.isWindowOpen ? 'open' : 'closed'}, call ${c.status}.`,
    ...problems(b).map(problem => `- ${problem}`),
  ].join('\n')
}

/** What stands between the person and a working call, each with its fix. */
function problems(b: WolfbudBridge): string[] {
  if (b.status === 'error') return [`The bridge failed: ${b.error ?? 'unknown error'}. /wolfbud starts it again.`]
  if (b.status !== 'ready') return []
  const found: string[] = []
  if (!b.hasApiKey) found.push('No ElevenLabs API key: set ELEVENLABS_API_KEY (or the api_key option) and restart Claude Code.')
  if (!b.hasAgent) found.push('No agent yet: run `pnpm agent:sync` in the wolfbud-claude-mod repo.')
  if (!b.isWindowBuilt) found.push('The window is not built: run `pnpm window:build` in the wolfbud-claude-mod repo.')
  return found
}

function callLabel(c: WolfbudCall): { text: string; color?: string } {
  switch (c.status) {
    case 'live':
      return { text: c.mode === 'speaking' ? '● on a call · talking' : '● on a call · listening', color: 'green' }
    case 'connecting':
      return { text: '◌ connecting…', color: 'yellow' }
    case 'error':
      return { text: '✕ call failed', color: 'red' }
    default:
      return { text: '○ not on a call' }
  }
}

const ROLE_LABEL: Record<WolfbudLine['role'], { text: string; color?: string }> = {
  user: { text: 'you', color: 'cyan' },
  agent: { text: 'wolf', color: 'magenta' },
  sent: { text: '→ claude', color: 'yellow' },
  note: { text: '·' },
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wolfbud',
      description: 'WolfBud: a voice coworker that watches this session and can message Claude',
      argumentHint: '[call | end | window | stop | status]',
    })
    // A reload killed the old bridge: bring it back on the same port and key
    // so a window that's open (and its call) reconnects on its own.
    if (e.isInteractive && (await read($, bridge)).isWanted) await startBridge($)
    return next(e)
  })

  on('command.run', { command: 'wolfbud' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    switch (arg) {
      case '':
      case 'open':
        await openPane($)
        return { text: await showWindow($, false) }
      case 'call':
        await openPane($)
        return { text: await showWindow($, true) }
      case 'end':
        return { text: (await tell($, 'end-call')) ? 'Ending the call.' : 'No WolfBud window is open.' }
      case 'window':
        if ((await read($, bridge)).status === 'ready') {
          await openWindow($, false)
          return { text: "Opening WolfBud's window." }
        }
        return { text: await showWindow($, false) }
      case 'stop':
        await stopBridge($)
        return { text: 'WolfBud stopped.' }
      case 'status':
        return { text: await statusText($) }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const from =
      e.origin.kind === 'plugin'
        ? e.origin.name === 'wolfbud'
          ? 'wolfbud'
          : null
        : ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
          ? 'user'
          : null
    if (from !== null && e.text.trim() !== '') {
      const text = from === 'wolfbud' ? e.text.replace(LEAD, '').trim() : e.text
      await report($, { kind: 'prompt', at: await $.clock.now(), text: clip(text, 1500), from })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, claude, () => ({ isBusy: true, turnId: e.turnId }))
    await report($, { kind: 'turn-start', at: await $.clock.now() })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const { tool, tool_use_id: _id, agentId, consent: _consent, ...input } = e as unknown as Record<string, unknown>
    const name = String(tool)
    const status = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const error = errorGist(ran.deny ?? (ran.isError === true ? ran.text : undefined))
    await report($, {
      kind: 'tool',
      at: await $.clock.now(),
      tool: toolLabel(name),
      detail: describeTool(name, input),
      status,
      ...(error !== undefined ? { error } : {}),
      ...(agentId !== undefined ? { isSubagent: true as const } : {}),
    })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, claude, () => ({ isBusy: false, turnId: null }))
      await report($, {
        kind: 'turn-complete',
        at: await $.clock.now(),
        answer: e.answer.slice(0, 4000),
        reason: e.reason,
        durationMs: e.durationMs,
      })
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    await report($, { kind: 'notification', at: await $.clock.now(), message: clip(e.message, 300), type: e.notification_type })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, claude, () => ({ isBusy: false, turnId: null }))
      await report($, {
        kind: 'notification',
        at: await $.clock.now(),
        message: "The user cleared Claude's conversation (/clear). Claude starts fresh and remembers nothing from before.",
        type: 'clear',
      })
    } else {
      await tell($, 'end-call')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, bridge)
    const c = await read($, call)
    const list = await read($, lines)
    const { isBusy } = await read($, claude)
    const found = problems(b)
    // The terminal clips a pane's tree from the bottom, so keep the newest lines
    // that fit beside the header and buttons, and drop the oldest off the top.
    const { bodyColumns, scroll } = e.props
    const room = scroll.bodyRows - PANE_CHROME_ROWS - found.reduce((rows, problem) => rows + wrappedRows(problem, bodyColumns), 0)
    const shown =
      e.surface === 'terminal'
        ? fitTail(list, Math.max(1, room), bodyColumns - LINE_INDENT)
        : list.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 10))
    const status = callLabel(c)
    const isOnCall = c.status === 'live' || c.status === 'connecting'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>WolfBud</Text>
          <Text color={status.color} dimColor={status.color === undefined}>
            {status.text}
          </Text>
        </Box>
        <Text dimColor>{isBusy ? 'Claude is working' : 'Claude is idle'}</Text>
        {found.map(problem => (
          <Text color="yellow" wrap="wrap">
            {problem}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          {shown.length === 0 && (
            <Text dimColor wrap="wrap">
              Call WolfBud to talk through what Claude is doing. What you agree on gets sent to Claude, and shows up here.
            </Text>
          )}
          {shown.map(line => (
            <Box key={`line-${line.id}`} flexDirection="row" gap={1}>
              <Box width={8} flexShrink={0}>
                <Text color={ROLE_LABEL[line.role].color} dimColor={line.role === 'note'}>
                  {ROLE_LABEL[line.role].text}
                </Text>
              </Box>
              <Text wrap="wrap" dimColor={line.role === 'note'}>
                {line.text}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          {isOnCall ? (
            <Button key="end" label="End call" hotkey="e" onPress={() => tell($, 'end-call')} />
          ) : (
            <Button key="call" label="Call WolfBud" hotkey="c" variant="primary" onPress={() => showWindow($, true)} />
          )}
          <Button key="window" label="Window" hotkey="w" onPress={() => raiseWindow($)} />
        </Box>
      </Box>
    )
  })
}
