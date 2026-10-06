// The WolfBud hub: one switchboard for every Claude session.
//
// It is not a child of any session. A launcher (launch.mjs) starts it detached
// on 127.0.0.1:4747 and exits; the port does not walk, because the mic grant is
// per origin. Sessions subscribe, post events, and long-poll their own inbox.
// The window is the only face: one Chrome app window, opened here, talking to
// this process over SSE.
//
// Three keys, on purpose:
//   - service token (~/.wolfbud/hub.json): a mod may subscribe. It is not in
//     the window URL.
//   - window key (the URL hash): the page may watch the roster and enqueue a
//     command for a short name. It cannot pull an inbox. Chrome's command line
//     shows it, so it stays the weakest key.
//   - session token (from subscribe): that session's mod may pull its inbox,
//     ack, show the window and end the call. It cannot enqueue for every session.
//
// Env: WOLFBUD_PORT (default 4747, no fallback ports), WOLFBUD_TOKEN and
// WOLFBUD_WINDOW_KEY (else the saved or fresh ones), ELEVENLABS_API_KEY (else
// the key a subscribing session brings), WOLFBUD_AGENT_ID (use as-is, never
// synced), WOLFBUD_NO_WINDOW=1 (tests: do not spawn Chrome).

import { execFile, spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { detailOf, loadDefinition, syncAgent } from './agent.mjs'
import { AGENT_PATH, CHROME_DIR, DEFAULT_PORT, HUB_PATH, readJsonFile, writePrivateJson } from './paths.mjs'

const run = promisify(execFile)
const WINDOW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'window')
const ELEVENLABS = 'https://api.elevenlabs.io/v1'

const PORT = Number(process.env.WOLFBUD_PORT) || DEFAULT_PORT
const AGENT_OVERRIDE = process.env.WOLFBUD_AGENT_ID || ''
const DEFINITION = loadDefinition()
const MAX_BODY = 256 * 1024
const ACK_TIMEOUT_MS = 15_000
const POLL_MS = Number(process.env.WOLFBUD_POLL_MS) || 20_000
const RECENT_LIMIT = 150
const LINE_LIMIT = 80

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
}

const savedHub = readJsonFile(HUB_PATH)
const SERVICE_TOKEN = process.env.WOLFBUD_TOKEN || savedHub?.token || randomUUID()
const WINDOW_KEY = process.env.WOLFBUD_WINDOW_KEY || savedHub?.windowKey || randomUUID()

/** sessionId -> row. The short name is the voice's handle for the row. */
const sessions = new Map()
/** session token -> row, for the session routes. */
const rowsByToken = new Map()
/** The one open SSE stream: the window. A newer one supersedes it. */
let face = null
/** Window requests waiting on a mod: command id -> resolve. */
const pending = new Map()
let focusedId = null
/** The call as the window last reported it. Every pull carries it. */
let callState = { status: 'idle', mode: null, error: null }
/** A session asked for a call before the window could take it. */
let callWanted = false
let commandSeq = 0
/** The ElevenLabs key: from env, else the latest one a session brought. Never reaches the browser. */
let apiKey = process.env.ELEVENLABS_API_KEY || ''
/** The agent calls go to. '' until set up, unless an override or a saved match. */
let agentId = AGENT_OVERRIDE || savedAgentId()
let settingUp = null

function log(...parts) {
  process.stderr.write(`[wolfbud-hub] ${parts.join(' ')}\n`)
}

function savedAgentId() {
  const saved = readJsonFile(AGENT_PATH)
  return saved?.def === DEFINITION.hash && typeof saved.id === 'string' ? saved.id : ''
}

function readyAgent() {
  if (agentId) return Promise.resolve(agentId)
  settingUp ??= syncAgent(apiKey, DEFINITION, { log: line => log('agent:', line) })
    .then(id => {
      agentId = id
      writePrivateJson(AGENT_PATH, { id, def: DEFINITION.hash })
      return id
    })
    .finally(() => {
      settingUp = null
    })
  return settingUp
}

/** Takes a key a session brought when we have none. The agent gets set up with it. */
function adoptApiKey(key) {
  if (typeof key !== 'string' || key === '' || apiKey !== '') return
  apiKey = key
  readyAgent().catch(error => log('agent setup failed:', error?.message ?? error))
}

function isWindowBuilt() {
  return existsSync(join(WINDOW_DIR, 'index.html'))
}

function sameSecret(given, expected) {
  const left = Buffer.from(String(given ?? ''))
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function hasServiceToken(req) {
  return sameSecret(req.headers['x-wolfbud-key'], SERVICE_TOKEN)
}

function hasWindowKey(req, url) {
  return sameSecret(req.headers['x-wolfbud-key'] ?? url.searchParams.get('k'), WINDOW_KEY)
}

function sessionOf(req) {
  return rowsByToken.get(String(req.headers['x-wolfbud-session'] ?? '')) ?? null
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isLocalRequest(req) {
  const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]
  if (!allowed.includes(String(req.headers.host))) return false
  const origin = req.headers.origin
  return origin === undefined || allowed.some(host => origin === `http://${host}`)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sse(res, event, data) {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** To the window, when there is one. */
function tellWindow(event, data) {
  if (face) sse(face, event, data)
  return face !== null
}

function slug(project) {
  const base = String(project ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  return base || 'session'
}

function shortName(project) {
  const taken = new Set([...sessions.values()].map(row => row.name))
  const base = slug(project)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function rosterRow(row) {
  return { id: row.id, name: row.name, project: row.project, isBusy: row.isBusy, badge: row.badge }
}

function rosterPayload() {
  return { focusedId, rows: [...sessions.values()].map(rosterRow) }
}

function needsYou(event) {
  if (event?.kind === 'turn-complete') return true
  if (event?.kind === 'notification' && event.type !== 'clear' && !/idle/i.test(String(event.type))) return true
  return false
}

/** Records an event on its row. True when the roster has to be redrawn. */
function noteEvent(row, event) {
  const before = `${row.isBusy}/${row.badge}`
  row.events.push(event)
  if (row.events.length > RECENT_LIMIT) row.events.splice(0, row.events.length - RECENT_LIMIT)
  if (event.kind === 'turn-start') row.isBusy = true
  if (event.kind === 'turn-complete') row.isBusy = false
  if (row.id !== focusedId && needsYou(event)) row.badge += 1
  return before !== `${row.isBusy}/${row.badge}`
}

function wake(row) {
  row.waiters.shift()?.finish()
}

function wakeAll() {
  for (const row of sessions.values()) wake(row)
}

function pushLine(line) {
  for (const row of sessions.values()) {
    row.lines.push(line)
    if (row.lines.length > LINE_LIMIT) row.lines.splice(0, row.lines.length - LINE_LIMIT)
    wake(row)
  }
}

function flush(row, res) {
  sendJson(res, 200, { commands: row.queue.splice(0), lines: row.lines.splice(0), call: callState, isWindowOpen: face !== null })
}

/** Answers right away when something is queued; otherwise holds the request until something is, or POLL_MS passes. */
function pull(row, req, res) {
  if (row.queue.length > 0 || row.lines.length > 0) return flush(row, res)
  let settled = false
  const waiter = { finish: () => settle(true) }
  const timer = setTimeout(() => settle(true), POLL_MS)
  function settle(answer) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    row.waiters = row.waiters.filter(item => item !== waiter)
    if (answer) flush(row, res)
  }
  row.waiters.push(waiter)
  req.on('close', () => settle(false))
}

function enqueue(row, command) {
  row.queue.push(command)
  wake(row)
}

function resolveName(name) {
  const wanted = String(name ?? '')
    .trim()
    .toLowerCase()
  if (wanted === '') {
    const row = focusedId ? (sessions.get(focusedId) ?? null) : null
    return { row, error: row ? null : 'No Claude session is subscribed. Run /wolfbud in one.' }
  }
  const matches = [...sessions.values()].filter(row => row.name.toLowerCase() === wanted)
  if (matches.length === 1) return { row: matches[0], error: null }
  const names = [...sessions.values()].map(row => row.name)
  if (matches.length === 0) {
    return { row: null, error: `No Claude session named ${wanted}. Subscribed: ${names.join(', ') || 'none'}.` }
  }
  return { row: null, error: `More than one session matches ${wanted}.` }
}

function healthBody() {
  return {
    ok: true,
    hasApiKey: apiKey !== '',
    isWindowBuilt: isWindowBuilt(),
    windows: face === null ? 0 : 1,
  }
}

function subscribe(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return { status: 400, body: { error: 'sessionId required' } }
  adoptApiKey(body.apiKey)
  const project = String(body.project ?? 'session')
  let row = sessions.get(sessionId)
  if (!row) {
    row = {
      id: sessionId,
      token: randomUUID(),
      name: shortName(project),
      project,
      isBusy: Boolean(body.isBusy),
      badge: 0,
      events: [],
      snapshot: '',
      queue: [],
      lines: [],
      waiters: [],
    }
    sessions.set(sessionId, row)
    rowsByToken.set(row.token, row)
    if (!focusedId) focusedId = sessionId
  } else {
    row.project = project
  }
  tellWindow('roster', rosterPayload())
  return { status: 200, body: { token: row.token, name: row.name, ...healthBody() } }
}

function dropSession(row) {
  for (const waiter of [...row.waiters]) waiter.finish()
  sessions.delete(row.id)
  rowsByToken.delete(row.token)
  if (focusedId === row.id) focusedId = sessions.keys().next().value ?? null
  tellWindow('roster', rosterPayload())
}

function setFocus(row) {
  focusedId = row.id
  row.badge = 0
  tellWindow('roster', rosterPayload())
}

function applyEvents(row, body) {
  let rosterChanged = false
  for (const event of body.events ?? []) {
    if (!event || typeof event !== 'object') continue
    if (noteEvent(row, event)) rosterChanged = true
    tellWindow('claude', { sessionId: row.id, event })
  }
  if (typeof body.snapshot === 'string') {
    row.snapshot = body.snapshot
    tellWindow('snapshot', { sessionId: row.id, text: body.snapshot })
  }
  if (rosterChanged) tellWindow('roster', rosterPayload())
}

function awaitAck(row, command) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(command.id)
      row.queue = row.queue.filter(item => item.id !== command.id)
      resolve({ ok: false, message: 'Claude Code did not answer in time. Try again in a moment.' })
    }, ACK_TIMEOUT_MS)
    pending.set(command.id, result => {
      clearTimeout(timer)
      pending.delete(command.id)
      resolve(result)
    })
    enqueue(row, command)
  })
}

function ack(body) {
  const waiting = pending.get(body.id)
  if (!waiting) return false
  waiting({ ok: Boolean(body.ok), message: String(body.message ?? '') })
  return true
}

/** The pid of our Chrome's browser process: the one on our profile with no `--type=` (helpers carry one). */
async function ourChromePid() {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await run('ps', ['-ax', '-o', 'pid=,command='])
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match && match[2].includes(CHROME_DIR) && !match[2].includes('--type=')) return Number(match[1])
    }
  } catch {
    // No ps: the SSE raise below is all we have.
  }
  return null
}

function raiseChrome(pid) {
  if (!pid || process.env.WOLFBUD_NO_WINDOW === '1') return
  spawn('osascript', ['-e', `tell application "System Events" to set frontmost of the first process whose unix id is ${pid} to true`], {
    stdio: 'ignore',
    detached: true,
  }).unref()
}

function launchChrome() {
  if (process.env.WOLFBUD_NO_WINDOW === '1') {
    log('window launch skipped')
    return
  }
  spawn(
    'open',
    [
      '-na',
      'Google Chrome',
      '--args',
      `--user-data-dir=${CHROME_DIR}`,
      `--app=http://127.0.0.1:${PORT}/#k=${WINDOW_KEY}`,
      '--window-size=400,680',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { stdio: 'ignore', detached: true },
  ).unref()
}

/** Starts the one call once a window is there to take it and none is live. */
function reconcileCall() {
  if (!callWanted || callState.status !== 'idle') return
  if (tellWindow('command', { cmd: 'start-call' })) callWanted = false
}

/** Opens the one Chrome window, or raises it. Never starts a second instance of this profile. */
async function showFace(call) {
  if (call) callWanted = true
  const pid = await ourChromePid()
  if (face) {
    raiseChrome(pid)
    tellWindow('command', { cmd: 'raise' })
    reconcileCall()
    return { connected: true }
  }
  if (pid === null) launchChrome()
  else raiseChrome(pid)
  return { connected: false }
}

async function serveStatic(res, pathname) {
  if (!isWindowBuilt()) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><title>WolfBud</title><body style="font:15px system-ui;padding:24px;background:#141428;color:#e8e8ff">' +
        '<h2>The WolfBud window isn’t built yet</h2><p>In the wolfbud-claude-mod repo run <code>pnpm install &amp;&amp; pnpm window:build</code>, then reload.</p>',
    )
    return
  }
  const file = resolve(WINDOW_DIR, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`)
  if (file !== WINDOW_DIR && !file.startsWith(WINDOW_DIR + sep)) {
    res.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=3600',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
}

function openStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  tellWindow('command', { cmd: 'superseded' })
  face = res
  sse(res, 'hello', {
    focusedId,
    rows: [...sessions.values()].map(row => ({ ...rosterRow(row), recent: row.events, snapshot: row.snapshot })),
  })
  wakeAll()
  reconcileCall()
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(ping)
    if (face !== res) return
    face = null
    wakeAll()
  })
}

async function fromWindow(body, res) {
  switch (body.type) {
    case 'status': {
      const status = body.call === 'connecting' || body.call === 'live' || body.call === 'error' ? body.call : 'idle'
      callState = { status, mode: body.mode ?? null, error: typeof body.error === 'string' ? body.error : null }
      if (status !== 'idle') callWanted = false
      wakeAll()
      return sendJson(res, 200, { ok: true })
    }
    case 'line':
      pushLine({ role: body.role === 'user' ? 'user' : 'agent', text: String(body.text ?? '').slice(0, 2000) })
      return sendJson(res, 200, { ok: true })
    case 'focus': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      setFocus(row)
      return sendJson(res, 200, { ok: true, name: row.name })
    }
    case 'snapshot': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      enqueue(row, { id: `cmd_${++commandSeq}`, type: 'snapshot' })
      return sendJson(res, 202, { ok: true })
    }
    case 'send': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      const result = await awaitAck(row, {
        id: `cmd_${++commandSeq}`,
        type: 'send',
        prompt: String(body.prompt ?? '').slice(0, 20_000),
        when: body.when === 'now' ? 'now' : 'after_current',
        summary: String(body.summary ?? '').slice(0, 200),
      })
      return sendJson(res, 200, result)
    }
    case 'stop': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      const result = await awaitAck(row, { id: `cmd_${++commandSeq}`, type: 'stop', reason: String(body.reason ?? '').slice(0, 500) })
      return sendJson(res, 200, result)
    }
    default:
      return sendJson(res, 400, { error: 'unknown type' })
  }
}

async function requestToken(id) {
  const res = await fetch(`${ELEVENLABS}/convai/conversation/token?agent_id=${encodeURIComponent(id)}`, {
    headers: { 'xi-api-key': apiKey },
  })
  return { status: res.status, ok: res.ok, text: await res.text() }
}

async function mintToken() {
  if (apiKey === '') {
    return [503, { error: 'no_api_key', message: 'Set ELEVENLABS_API_KEY (or the api_key option), then run /wolfbud again.' }]
  }
  let res
  try {
    res = await requestToken(await readyAgent())
    if (res.status === 404 && !AGENT_OVERRIDE) {
      agentId = ''
      res = await requestToken(await readyAgent())
    }
  } catch (error) {
    return [502, { error: 'agent', message: `Couldn't get the WolfBud agent ready: ${error?.message ?? error}` }]
  }
  if (!res.ok) return [502, { error: 'elevenlabs', message: `ElevenLabs refused the token (${res.status}): ${detailOf(res.text)}` }]
  return [200, { token: JSON.parse(res.text).token }]
}

/** The routes a subscribed session's mod uses, by its session token alone. */
async function fromSession(row, action, req, res) {
  switch (`${req.method} ${action}`) {
    case 'GET commands':
      return pull(row, req, res)
    case 'POST events':
      applyEvents(row, await readJson(req))
      return sendJson(res, 200, { ok: true })
    case 'POST ack':
      return sendJson(res, 200, { ok: ack(await readJson(req)) })
    case 'POST bye':
      dropSession(row)
      return sendJson(res, 200, { ok: true })
    case 'POST window': {
      const body = await readJson(req)
      setFocus(row)
      return sendJson(res, 200, { ok: true, ...(await showFace(Boolean(body.call))) })
    }
    case 'POST call/end':
      callWanted = false
      return sendJson(res, 200, { delivered: tellWindow('command', { cmd: 'end-call' }) })
    default:
      return sendJson(res, 405, { error: 'method' })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (!isLocalRequest(req)) {
    res.writeHead(403).end()
    return
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return void res.writeHead(405).end()
    return serveStatic(res, url.pathname)
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, healthBody())

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      if (!hasServiceToken(req)) return sendJson(res, 401, { error: 'bad key' })
      const result = subscribe(await readJson(req))
      return sendJson(res, result.status, result.body)
    }

    const sessionRoute = /^\/api\/session\/(.+)$/.exec(url.pathname)
    if (sessionRoute) {
      const row = sessionOf(req)
      if (!row) return sendJson(res, 401, { error: 'bad session' })
      return fromSession(row, sessionRoute[1], req, res)
    }

    // From here the caller is the window. A session token is not accepted.
    if (!hasWindowKey(req, url)) return sendJson(res, 401, { error: 'bad key' })
    if (req.method === 'GET' && url.pathname === '/api/token') {
      const [status, body] = await mintToken()
      return sendJson(res, status, body)
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') return openStream(req, res)
    if (req.method === 'POST' && url.pathname === '/api/page') return fromWindow(await readJson(req), res)
    return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    log('request failed:', error?.message ?? error)
    if (!res.headersSent) sendJson(res, 400, { error: String(error?.message ?? error) })
  }
})

// The launcher's exit must not take the hub with it, and neither must a
// session's. SIGTERM and SIGINT still stop it on purpose.
process.on('SIGHUP', () => {
  // The launcher exits as soon as we are up. A hangup from that must not stop the hub.
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    tellWindow('bye', {})
    process.exit(0)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  writePrivateJson(HUB_PATH, { port: PORT, token: SERVICE_TOKEN, windowKey: WINDOW_KEY })
  log(`listening on http://127.0.0.1:${PORT}`)
  if (apiKey !== '') readyAgent().catch(error => log('agent setup failed:', error?.message ?? error))
})

server.on('error', error => {
  if (error?.code === 'EADDRINUSE') {
    // Another hub holds the port: the launcher that started us finds it healthy.
    log(`port ${PORT} is taken; leaving it to the hub already there`)
    process.exit(0)
  }
  log(error?.message ?? error)
  process.exit(1)
})
