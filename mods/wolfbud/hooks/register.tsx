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
import type { ClaudeEvent, HubCall, HubCommand, PullResponse } from './events'

const PANE = 'wolfbud'
// Fixed origin: the mic grant is per origin, so the port does not walk.
const PORT = 4747
const ORIGIN = `http://127.0.0.1:${PORT}`
const MAX_LINES = 80
// The pane's rows besides the transcript: the call line, Claude's line, the two
// margins and the buttons. A transcript line's text starts after its 8-cell
// label and a 1-cell gap.
const PANE_CHROME_ROWS = 5
const LINE_INDENT = 9
const USAGE = 'Usage: /wolfbud [call | end | window | hide | stop | status]'
const LEAD = 'The user asked WolfBud, the voice assistant on a call beside this session, to pass this on:'
const HUB_DOWN = 'WolfBud hub is down. This session keeps working.'
const TUNNEL = `ssh -R ${PORT}:127.0.0.1:${PORT} <this host>`
const REMOTE_NO_HUB =
  "Can't reach the WolfBud hub from this remote session. The hub runs on your own machine: start it there first " +
  `(/wolfbud in a local Claude session), then tunnel port ${PORT} back to it from your machine, e.g. \`${TUNNEL}\`. ` +
  'See "Remote sessions" in the wolfbud README.'
const REMOTE_NO_TOKEN =
  'The hub answers through the tunnel, but this machine has no hub token. On your machine run ' +
  "`jq '{token}' ~/.wolfbud/hub.json` and save the output here as ~/.wolfbud/hub.json, then /wolfbud again."
const LOCAL_NO_TOKEN = 'The hub is up, but ~/.wolfbud/hub.json has no token. Restart the hub, then /wolfbud again.'
const BAD_TOKEN = 'The hub refused the token in ~/.wolfbud/hub.json.'
const REMOTE_BAD_TOKEN = `${BAD_TOKEN} Copy it again from the machine running the hub: \`jq '{token}' ~/.wolfbud/hub.json\`.`
const REMOTE_READY = 'Remote session: connected to the hub on your machine through the tunnel.'
const NO_WINDOW = 'No WolfBud window is open.'

type Settings = { apiKey: string }
type SendCommand = Extract<HubCommand, { type: 'send' }>
type StopCommand = Extract<HubCommand, { type: 'stop' }>
type HubResponse = { ok: boolean; status: number; text: string }

const IDLE_CALL: WolfbudCall = { status: 'idle', mode: null, error: null }
const IDLE_HUB: WolfbudHub = {
  status: 'off',
  error: null,
  isRemote: false,
  hasApiKey: false,
  isWindowBuilt: false,
  isWindowOpen: false,
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
// Events wait here for one POST once the hook that saw them has returned.
let eventBuffer: ClaudeEvent[] = []
let flushTimer: { cancel: () => void } | null = null

function readSettings(options: PluginOptions): Settings {
  return { apiKey: typeof options.api_key === 'string' ? options.api_key.trim() : '' }
}

async function patchHub($: EngineInterface, patch: Partial<WolfbudHub>): Promise<void> {
  await update($, hub, current => ({ ...current, ...patch }))
  await refreshStatus($)
}

/**
 * The pane folded into one status line: shown while this session is
 * subscribed and the pane is closed, cleared while the pane is up.
 */
async function refreshStatus($: EngineInterface): Promise<void> {
  const [b, c, { isBusy }, panes] = await Promise.all([read($, hub), read($, call), read($, claude), $.ui.panes()])
  if (b.status === 'off' || panes.some(pane => pane.id === PANE)) {
    $.ui.status(undefined)
    return
  }
  if (b.status === 'down') {
    $.ui.status(b.isRemote ? "WolfBud ✕ can't reach your machine's hub · /wolfbud status" : 'WolfBud ✕ hub down · /wolfbud to retry')
    return
  }
  const who = b.name !== '' ? `${b.name} · ` : ''
  $.ui.status(`WolfBud ${callLabel(c).text} · ${who}${isBusy ? 'Claude is working' : 'Claude is idle'} · /wolfbud to expand`)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'WolfBud' })
  await refreshStatus($)
}

async function addLine($: EngineInterface, role: WolfbudLine['role'], text: string): Promise<void> {
  await update($, lines, list => [...list, { id: (list.at(-1)?.id ?? 0) + 1, role, text }].slice(-MAX_LINES))
}

/**
 * One request to the hub. The session token goes along once there is one;
 * `/api/subscribe` alone takes the service token instead. Rejects on a
 * network error, like `$.http.fetch`.
 */
async function hubFetch(
  $: EngineInterface,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; serviceToken?: string } = {},
): Promise<HubResponse> {
  const current = await read($, hub)
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.serviceToken !== undefined) headers['x-wolfbud-key'] = init.serviceToken
  else if (current.sessionToken !== '') headers['x-wolfbud-session'] = current.sessionToken
  const res = await $.http.fetch(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { ok: res.ok, status: res.status, text: res.text }
}

async function readServiceToken($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  if (home === '') return null
  try {
    const parsed = JSON.parse(await $.fs.read(`${home}/.wolfbud/hub.json`)) as { token?: unknown }
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : null
  } catch {
    return null
  }
}

async function isHubUp($: EngineInterface): Promise<boolean> {
  try {
    return (await $.http.fetch(`${ORIGIN}/api/health`)).ok
  } catch {
    return false
  }
}

/**
 * Whether this Claude runs off the machine that owns the hub, window and mic.
 * WOLFBUD_REMOTE=1 or 0 decides; unset, an SSH login or a Claude Code cloud
 * session counts as remote. A container you exec into needs WOLFBUD_REMOTE=1.
 */
async function isRemoteSession($: EngineInterface): Promise<boolean> {
  const flag = ((await $.env.get('WOLFBUD_REMOTE')) ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes'].includes(flag)) return true
  if (['0', 'false', 'no'].includes(flag)) return false
  const [ssh, cloud] = await Promise.all([$.env.get('SSH_CONNECTION'), $.env.get('CLAUDE_CODE_REMOTE')])
  return Boolean(ssh) || cloud === 'true'
}

/** What the roster calls a remote session's machine: WOLFBUD_HOST, else HOSTNAME, else the SSH server's address. */
async function remoteHost($: EngineInterface): Promise<string> {
  const [named, hostname, ssh] = await Promise.all([$.env.get('WOLFBUD_HOST'), $.env.get('HOSTNAME'), $.env.get('SSH_CONNECTION')])
  return (named || hostname || (ssh ?? '').split(' ')[2] || '').trim()
}

/** Marks the hub down with what to do about it, and says so once each time the reason changes. */
async function markDown($: EngineInterface, reason = `${HUB_DOWN} /wolfbud tries again.`): Promise<void> {
  const before = await read($, hub)
  await patchHub($, { status: 'down', error: reason })
  if (before.status !== 'down' || before.error !== reason) $.ui.toast(`WolfBud: ${reason}`)
}

/** What a failed connect left to say, for a command's answer. */
async function downText($: EngineInterface): Promise<string> {
  return (await read($, hub)).error ?? HUB_DOWN
}

/**
 * Starts the hub if nothing is answering, then reads the token the hub wrote.
 * A remote session never starts one: a hub there would have no window, and it
 * would hold the port the tunnel needs once the tunnel comes back.
 */
async function ensureHub($: EngineInterface): Promise<boolean> {
  const isRemote = await isRemoteSession($)
  await patchHub($, { isRemote })
  if (!(await isHubUp($))) {
    if (isRemote) {
      await markDown($, REMOTE_NO_HUB)
      return false
    }
    const node = (await $.env.get('WOLFBUD_NODE')) || 'node'
    const ran = await $.process.run([node, `${$.plugin.root}/bridge/launch.mjs`], { timeoutMs: 20_000 }).catch(() => null)
    if (ran === null || ran.exitCode !== 0 || !(await isHubUp($))) {
      await markDown($)
      return false
    }
  }
  const token = await readServiceToken($)
  if (token === null) {
    await markDown($, isRemote ? REMOTE_NO_TOKEN : LOCAL_NO_TOKEN)
    return false
  }
  await patchHub($, { serviceToken: token })
  return true
}

/** Hub up and this session subscribed to it, from whatever state we are in. */
async function connect($: EngineInterface): Promise<boolean> {
  return (await ensureHub($)) && subscribe($)
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

function startPoll($: EngineInterface): void {
  pollGen += 1
  armPoll($, pollGen, 0)
}

/**
 * One pull of this session's inbox. The hub holds an empty request until
 * something is queued, so the loop mostly paces itself; the short gap after an
 * answer keeps a hub that answers at once from being hammered.
 */
async function poll($: EngineInterface, gen: number): Promise<void> {
  if (gen !== pollGen) return
  const current = await read($, hub)
  if (current.status === 'off') return
  if (current.status !== 'ready') {
    if (!(await connect($))) armPoll($, gen, 2000)
    return
  }
  let delay = 250
  try {
    const res = await hubFetch($, '/api/session/commands')
    if (gen !== pollGen) return
    if (res.status === 401) {
      // The hub forgot us (it restarted). subscribe() starts a fresh poll.
      await subscribe($)
      return
    }
    if (!res.ok) {
      delay = 2000
    } else {
      const body = JSON.parse(res.text) as PullResponse
      await applyCall($, body.call, body.isWindowOpen)
      for (const line of body.lines) await addLine($, line.role, line.text)
      for (const command of body.commands) await onCommand($, command)
    }
  } catch {
    if (gen !== pollGen) return
    await markDown($, current.isRemote ? REMOTE_NO_HUB : undefined)
    delay = 2000
  }
  if (gen !== pollGen) return
  armPoll($, gen, delay)
}

async function subscribe($: EngineInterface): Promise<boolean> {
  const current = await read($, hub)
  const sessionId = current.sessionId !== '' ? current.sessionId : crypto.randomUUID()
  const [cwd, { isBusy }, envKey, host] = await Promise.all([
    $.session.cwd(),
    read($, claude),
    $.env.get('ELEVENLABS_API_KEY'),
    current.isRemote ? remoteHost($) : Promise.resolve(''),
  ])
  try {
    const res = await hubFetch($, '/api/subscribe', {
      serviceToken: current.serviceToken,
      body: { sessionId, project: projectName(cwd), isBusy, isRemote: current.isRemote, host, apiKey: settings.apiKey || envKey || '' },
    })
    const body = res.ok
      ? (JSON.parse(res.text) as { token?: string; name?: string; hasApiKey?: boolean; isWindowBuilt?: boolean; windows?: number })
      : {}
    if (typeof body.token !== 'string' || body.token === '') {
      await markDown($, res.status === 401 ? (current.isRemote ? REMOTE_BAD_TOKEN : BAD_TOKEN) : undefined)
      return false
    }
    if (current.isRemote && current.status !== 'ready') await addLine($, 'note', REMOTE_READY)
    await patchHub($, {
      status: 'ready',
      sessionId,
      sessionToken: body.token,
      name: typeof body.name === 'string' ? body.name : projectName(cwd),
      hasApiKey: Boolean(body.hasApiKey),
      isWindowBuilt: Boolean(body.isWindowBuilt),
      isWindowOpen: Number(body.windows ?? 0) > 0,
      error: null,
    })
    startPoll($)
    return true
  } catch {
    await markDown($, current.isRemote ? REMOTE_NO_HUB : undefined)
    return false
  }
}

async function postEvents($: EngineInterface, body: { events?: ClaudeEvent[]; snapshot?: string }): Promise<void> {
  if ((await read($, hub)).status !== 'ready') return
  try {
    await hubFetch($, '/api/session/events', { body })
  } catch {
    // The next poll notices a hub that is gone.
  }
}

async function flushEvents($: EngineInterface): Promise<void> {
  flushTimer = null
  const events = eventBuffer
  eventBuffer = []
  if (events.length > 0) await postEvents($, { events })
}

/** Queues an event for the hub. The POST runs once the hook that saw it has returned, one for a whole burst. */
function report($: EngineInterface, event: ClaudeEvent): void {
  eventBuffer.push(event)
  flushTimer ??= $.clock.after(0, () => {
    void flushEvents($)
  })
}

async function ack($: EngineInterface, id: string, ok: boolean, message: string): Promise<void> {
  try {
    await hubFetch($, '/api/session/ack', { body: { id, ok, message } })
  } catch {
    // The voice tool times out on its own; the pane already has the line.
  }
}

async function showWindow($: EngineInterface, withCall: boolean, isRetry = false): Promise<string> {
  const current = await read($, hub)
  if (current.status !== 'ready' && !(await connect($))) return downText($)
  try {
    const res = await hubFetch($, '/api/session/window', { body: { call: withCall } })
    // The hub forgot us (it restarted): subscribe again, once.
    if (res.status === 401 && !isRetry) return (await connect($)) ? showWindow($, withCall, true) : downText($)
    if (!res.ok) return 'WolfBud could not open the window.'
    const body = JSON.parse(res.text) as { connected?: boolean }
    if (body.connected) await patchHub($, { isWindowOpen: true })
    const name = (await read($, hub)).name
    const focus = name !== '' ? `, focused on ${name}` : ''
    if (withCall) return `Calling WolfBud${focus}.`
    return body.connected ? `WolfBud is up${focus}.` : 'Opening WolfBud.'
  } catch {
    await markDown($, (await read($, hub)).isRemote ? REMOTE_NO_HUB : undefined)
    return downText($)
  }
}

async function endCall($: EngineInterface): Promise<string> {
  if ((await read($, hub)).status !== 'ready') return NO_WINDOW
  try {
    const res = await hubFetch($, '/api/session/call/end', { method: 'POST' })
    const body = res.ok ? (JSON.parse(res.text) as { delivered?: boolean }) : {}
    return body.delivered ? 'Ending the call.' : NO_WINDOW
  } catch {
    return HUB_DOWN
  }
}

async function unsubscribe($: EngineInterface): Promise<void> {
  stopPoll()
  flushTimer?.cancel()
  flushTimer = null
  eventBuffer = []
  if ((await read($, hub)).status === 'ready') {
    try {
      await hubFetch($, '/api/session/bye', { method: 'POST' })
    } catch {
      // Leaving locally still stands.
    }
  }
  await update($, hub, () => IDLE_HUB)
  await update($, call, () => IDLE_CALL)
  await refreshStatus($)
}

/** The call as the hub reports it on every pull. A change of state is a note in the transcript. */
async function applyCall($: EngineInterface, next: HubCall, isWindowOpen: boolean): Promise<void> {
  const [before, current] = await Promise.all([read($, call), read($, hub)])
  if (current.isWindowOpen !== isWindowOpen) await patchHub($, { isWindowOpen })
  if (before.status === next.status && before.mode === next.mode && before.error === next.error) return
  await update($, call, () => next)
  await refreshStatus($)
  if (next.status === 'live' && before.status !== 'live') await addLine($, 'note', 'Call started')
  if (next.status !== 'live' && before.status === 'live') await addLine($, 'note', 'Call ended')
  if (next.status === 'error' && next.error && before.error !== next.error) await addLine($, 'note', next.error)
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
      await sendSnapshot($)
      return
  }
}

/** The transcript so far, posted back for the agent. No ack: the hub does not wait on it. */
async function sendSnapshot($: EngineInterface): Promise<void> {
  const [found, cwd, { isBusy }, { name }] = await Promise.all([$.session.messages(), $.session.cwd(), read($, claude), read($, hub)])
  const messages = Array.isArray(found) ? found : []
  await postEvents($, { snapshot: formatSnapshot(messages, { project: projectName(cwd), isBusy, name }) })
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
  const [b, c] = await Promise.all([read($, hub), read($, call)])
  const where = b.name !== '' ? `${b.name}, ` : ''
  const hubLine =
    b.status === 'ready'
      ? `hub on ${ORIGIN}${b.isRemote ? ' (remote session: through the tunnel to your machine)' : ''}`
      : `hub ${b.status}`
  return [
    `WolfBud: ${where}${hubLine}, window ${b.isWindowOpen ? 'open' : 'closed'}, call ${c.status}.`,
    ...problems(b).map(problem => `- ${problem}`),
  ].join('\n')
}

/** What stands between the person and a working call, each with its fix. */
function problems(b: WolfbudHub): string[] {
  if (b.status === 'down') return [b.error ?? HUB_DOWN]
  if (b.status !== 'ready') return []
  const found: string[] = []
  if (!b.hasApiKey) found.push('No ElevenLabs API key: set ELEVENLABS_API_KEY (or the api_key option), then run /wolfbud again.')
  if (!b.isWindowBuilt) {
    const where = b.isRemote ? ' on the machine running the hub' : ''
    found.push(`The window is not built: run \`pnpm window:build\` in the wolfbud-claude-mod repo${where}.`)
  }
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
      argumentHint: '[call | end | window | hide | stop | status]',
    })
    // A reload dropped the poll. The hub is still up; subscribe the same session again.
    if (e.isInteractive && (await read($, hub)).status !== 'off') await connect($)
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
        return { text: await endCall($) }
      case 'window':
        return { text: await showWindow($, false) }
      case 'hide':
        await $.ui.close({ id: PANE })
        return { text: 'WolfBud folded into the status line. /wolfbud brings the pane back.' }
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
      report($, { kind: 'prompt', at: await $.clock.now(), text: clip(text, 1500), from })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, claude, () => ({ isBusy: true, turnId: e.turnId }))
    await refreshStatus($)
    report($, { kind: 'turn-start', at: await $.clock.now() })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const { tool, tool_use_id: _id, agentId, consent: _consent, ...input } = e as unknown as Record<string, unknown>
    const name = String(tool)
    const status = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const error = errorGist(ran.deny ?? (ran.isError === true ? ran.text : undefined))
    report($, {
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
      await refreshStatus($)
      report($, {
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
    report($, { kind: 'notification', at: await $.clock.now(), message: clip(e.message, 300), type: e.notification_type })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear is a new session. Either way this subscription ends; other Claudes stay.
    await update($, claude, () => ({ isBusy: false, turnId: null }))
    await unsubscribe($)
    return next(e)
  })

  // The person closing the pane (its mark or a key) folds it into the status line too.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await refreshStatus($)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [b, c, list, { isBusy }] = await Promise.all([read($, hub), read($, call), read($, lines), read($, claude)])
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
        <Text dimColor>
          {b.status === 'down'
            ? b.isRemote
              ? "can't reach your machine's hub, session still working"
              : 'hub down, session still working'
            : `${who}${b.isRemote ? 'remote · ' : ''}${isBusy ? 'Claude is working' : 'Claude is idle'}`}
        </Text>
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
          <Button key="hide" label="Hide" hotkey="h" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
