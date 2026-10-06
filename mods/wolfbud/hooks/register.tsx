// WolfBud: one voice beside every Claude Code session.
//
// The hooks here watch this session and subscribe it to a hub that outlives
// any one session (bridge/server.mjs on 127.0.0.1:4747). The hub serves one
// Chrome window: the 3D wolf and an ElevenLabs voice agent. A prompt the agent
// sends is queued for this session only; this mod pulls it and runs deliver().
// The hub never calls Claude. If the hub is down, the session keeps working
// and the pane says so.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { WolfbudCall, WolfbudHub, WolfbudLine } from '../types'
import { clip, describeTool, errorGist, fitTail, formatSnapshot, projectName, toolLabel, wrappedRows } from './activity'
import type { ClaudeEvent, HubCommand, HubNotice } from './events'

const PANE = 'wolfbud'
const PORT = 4747
const MAX_LINES = 80
// The pane's rows besides the transcript: the call line, Claude's line, the two
// margins and the buttons. A transcript line's text starts after its 8-cell
// label and a 1-cell gap.
const PANE_CHROME_ROWS = 5
const LINE_INDENT = 9
const USAGE = 'Usage: /wolfbud [call | end | window | stop | status]'
const LEAD = 'The user asked WolfBud, the voice assistant on a call beside this session, to pass this on:'
const CAPABILITIES = ['submit', 'steer', 'abort', 'snapshot']

type Settings = { apiKey: string }
type SendCommand = Extract<HubCommand, { type: 'send' }>
type StopCommand = Extract<HubCommand, { type: 'stop' }>

const IDLE_CALL: WolfbudCall = { status: 'idle', mode: null, error: null }
const IDLE_HUB: WolfbudHub = {
  status: 'off',
  port: PORT,
  error: null,
  hasApiKey: false,
  isWindowBuilt: false,
  isWindowOpen: false,
  isWanted: false,
  sessionId: '',
  sessionToken: '',
  serviceToken: '',
  name: '',
}

const hub = atom({ plugin: 'wolfbud', key: 'hub' } as const, IDLE_HUB)
const call = atom({ plugin: 'wolfbud', key: 'call' } as const, IDLE_CALL)
const lines = atom({ plugin: 'wolfbud', key: 'lines' } as const, [])
const claude = atom({ plugin: 'wolfbud', key: 'claude' } as const, { isBusy: false, turnId: null })

// Module variables reset on a reload. What must survive lives in $.state.
let settings: Settings = { apiKey: '' }
let pollTimer: { cancel: () => void } | null = null
let pollGen = 0

function readSettings(options: PluginOptions): Settings {
  return { apiKey: typeof options.api_key === 'string' ? options.api_key.trim() : '' }
}

async function patchHub($: EngineInterface, patch: Partial<WolfbudHub>): Promise<void> {
  await update($, hub, current => ({ ...current, ...patch }))
}

async function addLine($: EngineInterface, role: WolfbudLine['role'], text: string): Promise<void> {
  await update($, lines, list => [...list, { id: (list.at(-1)?.id ?? 0) + 1, role, text }].slice(-MAX_LINES))
}

function headers(current: WolfbudHub, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    ...(current.serviceToken !== '' ? { 'x-wolfbud-key': current.serviceToken } : {}),
    ...(current.sessionToken !== '' ? { 'x-wolfbud-session': current.sessionToken } : {}),
  }
}

async function readHubFile($: EngineInterface): Promise<{ port: number; token: string } | null> {
  const home = (await $.env.get('HOME')) ?? ''
  if (home === '') return null
  try {
    const text = await $.fs.read(`${home}/.wolfbud/hub.json`)
    const parsed = JSON.parse(text) as Record<string, unknown>
    const token = parsed.token
    const filePort = Number(parsed.port)
    if (typeof token !== 'string' || token === '' || !Number.isInteger(filePort)) return null
    return { port: filePort, token }
  } catch {
    return null
  }
}

async function health($: EngineInterface, target: number): Promise<{ hasApiKey: boolean; isWindowBuilt: boolean; windows: number } | null> {
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${target}/api/health`)
    if (!res.ok) return null
    const body = JSON.parse(res.text) as { hasApiKey?: boolean; isWindowBuilt?: boolean; windows?: number }
    return { hasApiKey: Boolean(body.hasApiKey), isWindowBuilt: Boolean(body.isWindowBuilt), windows: Number(body.windows ?? 0) }
  } catch {
    return null
  }
}

async function markDown($: EngineInterface): Promise<void> {
  await patchHub($, {
    status: 'down',
    error: 'WolfBud hub is down. This session keeps working. /wolfbud tries again.',
    isWanted: true,
  })
}

/** Starts the hub if nothing is answering, then reads the token the launcher wrote. */
async function ensureHub($: EngineInterface): Promise<boolean> {
  // The origin is fixed. A stale hub.json from a bridge that walked ports must not send us elsewhere.
  let up = await health($, PORT)
  if (up === null) {
    const node = (await $.env.get('WOLFBUD_NODE')) || 'node'
    const apiKey = settings.apiKey || (await $.env.get('ELEVENLABS_API_KEY')) || ''
    const agentId = (await $.env.get('WOLFBUD_AGENT_ID')) || ''
    const env: Record<string, string> = {}
    if (apiKey !== '') env.ELEVENLABS_API_KEY = apiKey
    if (agentId !== '') env.WOLFBUD_AGENT_ID = agentId
    const ran = await $.process.run([node, `${$.plugin.root}/bridge/launch.mjs`], { env, timeoutMs: 20_000 }).catch(() => null)
    if (ran === null || ran.exitCode !== 0) {
      await markDown($)
      return false
    }
    up = await health($, PORT)
  }
  const file = await readHubFile($)
  if (up === null || file === null) {
    await markDown($)
    return false
  }
  await patchHub($, {
    status: 'ready',
    port: file.port,
    serviceToken: file.token,
    hasApiKey: up.hasApiKey,
    isWindowBuilt: up.isWindowBuilt,
    isWindowOpen: up.windows > 0,
    error: null,
    isWanted: true,
  })
  return true
}

function stopPoll(): void {
  pollGen += 1
  pollTimer?.cancel()
  pollTimer = null
}

function armPoll($: EngineInterface, gen: number, ms: number): void {
  pollTimer?.cancel()
  pollTimer = $.clock.after(ms, () => {
    void poll($, gen)
  })
}

async function poll($: EngineInterface, gen: number): Promise<void> {
  if (gen !== pollGen) return
  const current = await read($, hub)
  if (!current.isWanted || current.sessionToken === '') return
  if (current.status !== 'ready') {
    if (await ensureHub($)) await subscribe($)
    else armPoll($, gen, 2000)
    return
  }
  let delay = 250
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}/api/sessions/${current.sessionId}/commands`, {
      headers: { 'x-wolfbud-session': current.sessionToken },
    })
    if (gen !== pollGen) return
    if (res.status === 401 || res.status === 404) {
      // subscribe() starts a fresh poll. Arming this generation too would double-pull.
      await subscribe($)
      return
    }
    if (!res.ok) {
      delay = 2000
    } else {
      const body = JSON.parse(res.text) as { commands?: HubCommand[]; notices?: HubNotice[] }
      for (const notice of body.notices ?? []) await onNotice($, notice)
      for (const command of body.commands ?? []) await onCommand($, command)
    }
  } catch {
    if (gen !== pollGen) return
    await markDown($)
    delay = 2000
  }
  if (gen !== pollGen) return
  const still = await read($, hub)
  if (!still.isWanted || still.sessionToken === '') return
  armPoll($, gen, delay)
}

function startPoll($: EngineInterface): void {
  pollGen += 1
  armPoll($, pollGen, 0)
}

async function subscribe($: EngineInterface): Promise<boolean> {
  const current = await read($, hub)
  const sessionId = current.sessionId !== '' ? current.sessionId : crypto.randomUUID()
  const cwd = await $.session.cwd()
  const { isBusy } = await read($, claude)
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wolfbud-key': current.serviceToken },
      body: JSON.stringify({
        sessionId,
        project: projectName(cwd),
        cwd,
        capabilities: CAPABILITIES,
        isBusy,
      }),
    })
    if (!res.ok) {
      await markDown($)
      return false
    }
    const body = JSON.parse(res.text) as { token?: string; name?: string; windowOpen?: boolean; hasApiKey?: boolean; isWindowBuilt?: boolean }
    if (typeof body.token !== 'string' || body.token === '') {
      await markDown($)
      return false
    }
    await patchHub($, {
      status: 'ready',
      sessionId,
      sessionToken: body.token,
      name: typeof body.name === 'string' ? body.name : projectName(cwd),
      isWindowOpen: Boolean(body.windowOpen),
      hasApiKey: Boolean(body.hasApiKey),
      isWindowBuilt: Boolean(body.isWindowBuilt),
      error: null,
      isWanted: true,
    })
    startPoll($)
    return true
  } catch {
    await markDown($)
    return false
  }
}

async function postEvents($: EngineInterface, body: unknown): Promise<boolean> {
  const current = await read($, hub)
  if (current.status !== 'ready' || current.sessionToken === '') return false
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}/api/sessions/${current.sessionId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(current) },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

async function report($: EngineInterface, event: ClaudeEvent): Promise<void> {
  const { isBusy } = await read($, claude)
  await postEvents($, { events: [event], isClaudeBusy: isBusy })
}

async function ack($: EngineInterface, id: string, ok: boolean, message: string): Promise<void> {
  const current = await read($, hub)
  if (current.sessionToken === '') return
  try {
    await $.http.fetch(`http://127.0.0.1:${current.port}/api/sessions/${current.sessionId}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wolfbud-session': current.sessionToken },
      body: JSON.stringify({ id, ok, message }),
    })
  } catch {
    // The voice tool times out on its own; the pane already has the line.
  }
}

async function showWindow($: EngineInterface, withCall: boolean): Promise<string> {
  if (!(await ensureHub($))) return 'WolfBud hub is down. This session keeps working.'
  if (!(await subscribe($))) return 'WolfBud hub is down. This session keeps working.'
  const current = await read($, hub)
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}/api/window`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(current) },
      body: JSON.stringify({ sessionId: current.sessionId, call: withCall }),
    })
    if (!res.ok) return 'WolfBud could not open the window.'
    const body = JSON.parse(res.text) as { connected?: boolean; opened?: boolean; name?: string }
    if (body.connected) await patchHub($, { isWindowOpen: true })
    const name = body.name || current.name
    if (withCall) return name !== '' ? `Calling WolfBud, focused on ${name}.` : 'Calling WolfBud.'
    return body.connected ? `WolfBud is up${name !== '' ? `, focused on ${name}` : ''}.` : 'Opening WolfBud.'
  } catch {
    return 'WolfBud hub is down. This session keeps working.'
  }
}

async function endCall($: EngineInterface): Promise<string> {
  const current = await read($, hub)
  if (current.status !== 'ready' || current.serviceToken === '') return 'No WolfBud window is open.'
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${current.port}/api/call/end`, {
      method: 'POST',
      headers: { 'x-wolfbud-key': current.serviceToken },
    })
    if (!res.ok) return 'No WolfBud window is open.'
    const body = JSON.parse(res.text) as { delivered?: boolean }
    return body.delivered ? 'Ending the call.' : 'No WolfBud window is open.'
  } catch {
    return 'WolfBud hub is down. This session keeps working.'
  }
}

async function unsubscribe($: EngineInterface): Promise<void> {
  stopPoll()
  const current = await read($, hub)
  if (current.sessionToken !== '' && current.status === 'ready') {
    try {
      await $.http.fetch(`http://127.0.0.1:${current.port}/api/sessions/${current.sessionId}/bye`, {
        method: 'POST',
        headers: { 'x-wolfbud-session': current.sessionToken },
      })
    } catch {
      // Leaving locally still stands: the hub drops a quiet row on its own only if we reached it.
    }
  }
  await patchHub($, { ...IDLE_HUB, port: current.port })
  await update($, call, () => IDLE_CALL)
}

async function onNotice($: EngineInterface, notice: HubNotice): Promise<void> {
  switch (notice.t) {
    case 'window':
      await patchHub($, { isWindowOpen: notice.open })
      if (!notice.open) await update($, call, () => IDLE_CALL)
      return
    case 'status': {
      const before = await read($, call)
      await update($, call, () => ({ status: notice.call, mode: notice.mode, error: notice.error ?? null }))
      if (notice.call === 'live' && before.status !== 'live') await addLine($, 'note', 'Call started')
      if (notice.call !== 'live' && before.status === 'live') await addLine($, 'note', 'Call ended')
      if (notice.call === 'error' && notice.error) await addLine($, 'note', notice.error)
      return
    }
    case 'line':
      await addLine($, notice.role, notice.text)
      return
  }
}

async function onCommand($: EngineInterface, command: HubCommand): Promise<void> {
  switch (command.type) {
    case 'send':
      await deliver($, command)
      return
    case 'stop':
      await stopClaude($, command)
      return
    case 'snapshot':
      await sendSnapshot($, command.id)
      return
  }
}

async function sendSnapshot($: EngineInterface, id: string): Promise<void> {
  const found = await $.session.messages()
  const messages = Array.isArray(found) ? found : []
  const cwd = await $.session.cwd()
  const { isBusy } = await read($, claude)
  const { name } = await read($, hub)
  await postEvents($, { snapshot: formatSnapshot(messages, { project: projectName(cwd), isBusy, name }) })
  await ack($, id, true, 'Snapshot sent.')
}

/** The agent's prompt for Claude: started, steered into the running turn, or queued. */
async function deliver($: EngineInterface, request: SendCommand): Promise<void> {
  const prompt = request.prompt.trim()
  if (prompt === '') {
    await ack($, request.id, false, 'The prompt was empty, so nothing was sent.')
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
  await ack($, request.id, true, message)
}

async function stopClaude($: EngineInterface, request: StopCommand): Promise<void> {
  const { isBusy, turnId } = await read($, claude)
  if (!isBusy || turnId === null) {
    await ack($, request.id, false, "Claude isn't running anything right now.")
    return
  }
  try {
    await $.turn.abort({ turnId })
    await addLine($, 'note', `Stopped Claude${request.reason ? `: ${request.reason}` : ''}`)
    await ack($, request.id, true, 'Stopped Claude.')
  } catch (error) {
    await ack($, request.id, false, `Couldn't stop Claude: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function statusText($: EngineInterface): Promise<string> {
  const b = await read($, hub)
  const c = await read($, call)
  const where = b.name !== '' ? `${b.name}, ` : ''
  const hubLine =
    b.status === 'ready'
      ? `hub on http://127.0.0.1:${b.port}`
      : `hub ${b.status}${b.error ? ` (${b.error})` : ''}`
  return [
    `WolfBud: ${where}${hubLine}, window ${b.isWindowOpen ? 'open' : 'closed'}, call ${c.status}.`,
    ...problems(b).map(problem => `- ${problem}`),
  ].join('\n')
}

/** What stands between the person and a working call, each with its fix. */
function problems(b: WolfbudHub): string[] {
  if (b.status === 'down' || b.status === 'error') {
    return [b.error ?? 'WolfBud hub is down. This session keeps working. /wolfbud tries again.']
  }
  if (b.status !== 'ready') return []
  const found: string[] = []
  if (!b.hasApiKey) found.push('No ElevenLabs API key: set ELEVENLABS_API_KEY (or the api_key option) and restart Claude Code.')
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
    // A reload dropped the poll. The hub is still up; subscribe the same session again.
    if (e.isInteractive && (await read($, hub)).isWanted) {
      if (await ensureHub($)) await subscribe($)
    }
    return next(e)
  })

  on('command.run', { command: 'wolfbud' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    switch (arg) {
      case '':
      case 'open':
        await $.ui.open({ id: PANE, title: 'WolfBud' })
        return { text: await showWindow($, false) }
      case 'call':
        await $.ui.open({ id: PANE, title: 'WolfBud' })
        return { text: await showWindow($, true) }
      case 'end':
        return { text: await endCall($) }
      case 'window':
        return { text: await showWindow($, false) }
      case 'stop':
        await unsubscribe($)
        return { text: 'This session left WolfBud. Other sessions keep the window.' }
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
    // /clear is a new session. Either way this subscription ends; other Claudes stay.
    if (e.reason === 'clear') {
      await update($, claude, () => ({ isBusy: false, turnId: null }))
    }
    await unsubscribe($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, hub)
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
    const who = b.name !== '' ? `${b.name} · ` : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>WolfBud</Text>
          <Text color={status.color} dimColor={status.color === undefined}>
            {status.text}
          </Text>
        </Box>
        <Text dimColor>{b.status === 'down' ? 'hub down, session still working' : `${who}${isBusy ? 'Claude is working' : 'Claude is idle'}`}</Text>
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
            <Button key="end" label="End call" hotkey="e" onPress={() => endCall($)} />
          ) : (
            <Button key="call" label="Call WolfBud" hotkey="c" variant="primary" onPress={() => showWindow($, true)} />
          )}
          <Button key="window" label="Window" hotkey="w" onPress={() => showWindow($, false)} />
        </Box>
      </Box>
    )
  })
}
