// The WolfBud hub: one switchboard for every Claude session.
//
// It is not a child of any session. A launcher (launch.mjs) starts it detached
// on 127.0.0.1:4747 and exits; the port does not walk, because the mic grant is
// per origin. Sessions subscribe, post events, and long-poll their own inbox.
// The window is the only face: one Chrome app window, opened here, talking to
// this process over SSE.
//
// Three keys, on purpose:
//   - service token (~/.wolfbud/hub.json): a mod may subscribe and ask to show
//     the window. It is not in the window URL.
//   - window key (the URL hash): the page may watch the roster and enqueue a
//     command for a short name. It cannot pull an inbox.
//   - session token (from subscribe): that session's mod may pull its inbox
//     and ack. It cannot enqueue for every session.
//
// Env: WOLFBUD_PORT (default 4747, no fallback ports), WOLFBUD_TOKEN,
// WOLFBUD_WINDOW_KEY, ELEVENLABS_API_KEY, WOLFBUD_AGENT_ID (use as-is, never
// synced), WOLFBUD_NO_WINDOW=1 (tests: do not spawn Chrome).

import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDefinition, syncAgent } from './agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WINDOW_DIR = resolve(HERE, 'window')
const HOME = process.env.HOME || homedir()
const WOLF_DIR = join(HOME, '.wolfbud')
const HUB_PATH = join(WOLF_DIR, 'hub.json')
const AGENT_PATH = join(WOLF_DIR, 'agent.json')
const CHROME_DIR = join(WOLF_DIR, 'chrome')
const ELEVENLABS = 'https://api.elevenlabs.io/v1'

const PORT = Number(process.env.WOLFBUD_PORT) || 4747
const API_KEY = process.env.ELEVENLABS_API_KEY || ''
const AGENT_OVERRIDE = process.env.WOLFBUD_AGENT_ID || ''
const DEFINITION = loadDefinition()
const MAX_BODY = 256 * 1024
const ACK_TIMEOUT_MS = 15_000
const POLL_MS = Number(process.env.WOLFBUD_POLL_MS) || 20_000
const RECENT_LIMIT = 150
const NOTICE_LIMIT = 80

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

const savedFile = readHubFile()
const SERVICE_TOKEN = process.env.WOLFBUD_TOKEN || savedFile?.token || randomUUID()
const WINDOW_KEY = process.env.WOLFBUD_WINDOW_KEY || savedFile?.windowKey || randomUUID()

/** sessionId -> row. The short name is the voice's handle for the row. */
const sessions = new Map()
/** Open SSE streams, newest last. One window holds the call. */
const windows = []
/** Window requests waiting on a mod: command id -> { res, timer }. */
const pending = new Map()
let focusedId = null
let callStatus = 'idle'
let commandSeq = 0
let pendingCall = false
let port = PORT
/** The agent calls go to. '' until set up, unless an override or a saved match. */
let agentId = AGENT_OVERRIDE || savedAgentId()
let settingUp = null

function log(...parts) {
  process.stderr.write(`[wolfbud-hub] ${parts.join(' ')}\n`)
}

function readHubFile() {
  try {
    return JSON.parse(readFileSync(HUB_PATH, 'utf8'))
  } catch {
    return null
  }
}

function persistHub() {
  mkdirSync(WOLF_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(
    HUB_PATH,
    `${JSON.stringify({ port, pid: process.pid, token: SERVICE_TOKEN, windowKey: WINDOW_KEY })}\n`,
    { mode: 0o600 },
  )
}

function savedAgentId() {
  try {
    const saved = JSON.parse(readFileSync(AGENT_PATH, 'utf8'))
    return saved?.def === DEFINITION.hash && typeof saved.id === 'string' ? saved.id : ''
  } catch {
    return ''
  }
}

function saveAgent(id) {
  mkdirSync(WOLF_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(AGENT_PATH, `${JSON.stringify({ id, def: DEFINITION.hash })}\n`, { mode: 0o600 })
}

function readyAgent() {
  if (agentId) return Promise.resolve(agentId)
  settingUp ??= syncAgent(API_KEY, DEFINITION, { log: line => log('agent:', line) })
    .then(id => {
      agentId = id
      saveAgent(id)
      return id
    })
    .finally(() => {
      settingUp = null
    })
  return settingUp
}

function isWindowBuilt() {
  try {
    readFileSync(join(WINDOW_DIR, 'index.html'))
    return true
  } catch {
    return false
  }
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

function sessionFromToken(req) {
  const token = String(req.headers['x-wolfbud-session'] ?? '')
  if (token === '') return null
  for (const row of sessions.values()) {
    if (sameSecret(token, row.token)) return row
  }
  return null
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isLocalRequest(req) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`]
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

function broadcast(event, data) {
  for (const res of windows) sse(res, event, data)
}

function slug(project) {
  const base = String(project ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  return base || 'session'
}

function shortName(project, exceptId) {
  const taken = new Set([...sessions.values()].filter(row => row.id !== exceptId).map(row => row.name))
  const base = slug(project)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function capabilitiesOf(value) {
  const list = Array.isArray(value) ? value : []
  return new Set(list.filter(item => item === 'submit' || item === 'steer' || item === 'abort' || item === 'snapshot'))
}

function rosterPayload() {
  return {
    focusedId,
    rows: [...sessions.values()].map(row => ({
      id: row.id,
      name: row.name,
      project: row.project,
      cwd: row.cwd,
      isBusy: row.isBusy,
      badge: row.badge,
    })),
  }
}

function focusPayload(row) {
  if (!row) return { id: null, name: null, project: '', recent: [], snapshot: '', isBusy: false }
  return {
    id: row.id,
    name: row.name,
    project: row.project,
    recent: row.events,
    snapshot: row.snapshot,
    isBusy: row.isBusy,
  }
}

function focusedRow() {
  return focusedId ? (sessions.get(focusedId) ?? null) : null
}

function needsYou(event) {
  if (event?.kind === 'turn-complete') return true
  if (event?.kind === 'notification' && event.type !== 'clear' && !/idle/i.test(String(event.type))) return true
  return false
}

function noteEvent(row, event) {
  row.events.push(event)
  if (row.events.length > RECENT_LIMIT) row.events.splice(0, row.events.length - RECENT_LIMIT)
  if (event.kind === 'turn-start') row.isBusy = true
  if (event.kind === 'turn-complete') row.isBusy = false
  if (row.id !== focusedId && needsYou(event)) row.badge += 1
}

function pushNotice(row, notice) {
  row.notices.push(notice)
  if (row.notices.length > NOTICE_LIMIT) row.notices.splice(0, row.notices.length - NOTICE_LIMIT)
  wake(row)
}

function notifyAll(notice) {
  for (const row of sessions.values()) pushNotice(row, notice)
}

function flush(row, res) {
  const commands = row.queue.splice(0)
  const notices = row.notices.splice(0)
  sendJson(res, 200, { commands, notices })
}

function wake(row) {
  const waiter = row.waiters.shift()
  waiter?.finish()
}

function pull(row, req, res) {
  if (row.queue.length > 0 || row.notices.length > 0) return flush(row, res)
  let settled = false
  const waiter = { finish }
  const timer = setTimeout(() => finish(), POLL_MS)
  function finish() {
    if (settled) return
    settled = true
    clearTimeout(timer)
    row.waiters = row.waiters.filter(item => item !== waiter)
    if (!res.writableEnded) flush(row, res)
  }
  row.waiters.push(waiter)
  req.on('close', () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    row.waiters = row.waiters.filter(item => item !== waiter)
  })
}

function enqueue(row, command) {
  row.queue.push(command)
  wake(row)
}

function resolveName(name) {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (wanted === '') return { row: focusedRow(), error: focusedRow() ? null : 'No Claude session is subscribed. Run /wolfbud in one.' }
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
    port,
    hasApiKey: Boolean(API_KEY),
    hasAgent: Boolean(agentId),
    isWindowBuilt: isWindowBuilt(),
    windows: windows.length,
    sessions: sessions.size,
  }
}

function subscribe(body) {
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : ''
  if (sessionId === '') return { status: 400, body: { error: 'sessionId required' } }
  const project = String(body.project ?? 'session')
  const cwd = String(body.cwd ?? '')
  let row = sessions.get(sessionId)
  if (!row) {
    row = {
      id: sessionId,
      token: randomUUID(),
      name: shortName(project, sessionId),
      project,
      cwd,
      capabilities: capabilitiesOf(body.capabilities),
      isBusy: Boolean(body.isBusy),
      badge: 0,
      events: [],
      snapshot: '',
      queue: [],
      notices: [],
      waiters: [],
    }
    sessions.set(sessionId, row)
    if (!focusedId) focusedId = sessionId
  } else {
    row.project = project
    row.cwd = cwd
    row.capabilities = capabilitiesOf(body.capabilities)
  }
  broadcast('roster', rosterPayload())
  return {
    status: 200,
    body: {
      sessionId: row.id,
      token: row.token,
      name: row.name,
      focused: row.id === focusedId,
      ...healthBody(),
      windowOpen: windows.length > 0,
    },
  }
}

function dropSession(id) {
  const row = sessions.get(id)
  if (!row) return false
  for (const waiter of [...row.waiters]) waiter.finish()
  sessions.delete(id)
  if (focusedId === id) {
    focusedId = sessions.keys().next().value ?? null
    broadcast('focus', focusPayload(focusedId ? sessions.get(focusedId) : null))
  }
  broadcast('roster', rosterPayload())
  return true
}

function setFocus(row) {
  focusedId = row.id
  row.badge = 0
  broadcast('focus', focusPayload(row))
  broadcast('roster', rosterPayload())
}

function applyEvents(row, body) {
  if (typeof body.project === 'string' && body.project !== '') row.project = body.project
  if (typeof body.cwd === 'string') row.cwd = body.cwd
  if (typeof body.isClaudeBusy === 'boolean') row.isBusy = body.isClaudeBusy
  for (const event of body.events ?? []) {
    if (!event || typeof event !== 'object') continue
    noteEvent(row, event)
    broadcast('claude', { sessionId: row.id, name: row.name, event })
  }
  if (typeof body.snapshot === 'string') {
    row.snapshot = body.snapshot
    broadcast('snapshot', { sessionId: row.id, name: row.name, text: body.snapshot })
  }
  broadcast('roster', rosterPayload())
}

function awaitAck(row, command) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(command.id)
      row.queue = row.queue.filter(item => item.id !== command.id)
      resolve({ ok: false, message: 'Claude Code did not answer in time. Try again in a moment.' })
    }, ACK_TIMEOUT_MS)
    pending.set(command.id, {
      timer,
      resolve: result => {
        clearTimeout(timer)
        pending.delete(command.id)
        resolve(result)
      },
    })
    enqueue(row, command)
  })
}

function ack(row, body) {
  const waiting = pending.get(body.id)
  if (!waiting) return false
  waiting.resolve({ ok: Boolean(body.ok), message: String(body.message ?? '') })
  return true
}

function ourChromePids() {
  if (process.platform === 'win32') return []
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    return out.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!match || !match[2].includes('.wolfbud/chrome')) return []
      return [Number(match[1])]
    })
  } catch {
    return []
  }
}

function raiseChrome(pid) {
  if (!pid || process.env.WOLFBUD_NO_WINDOW === '1') return
  spawn(
    'osascript',
    ['-e', `tell application "System Events" to set frontmost of the first process whose unix id is ${pid} to true`],
    { stdio: 'ignore', detached: true },
  ).unref()
}

function launchChrome() {
  if (process.env.WOLFBUD_NO_WINDOW === '1') {
    log('window launch skipped')
    return
  }
  const url = `http://127.0.0.1:${port}/#k=${WINDOW_KEY}`
  spawn(
    'open',
    [
      '-na',
      'Google Chrome',
      '--args',
      `--user-data-dir=${CHROME_DIR}`,
      `--app=${url}`,
      '--window-size=400,680',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { stdio: 'ignore', detached: true },
  ).unref()
}

/** Opens the one Chrome window, or raises it. Never starts a second instance of this profile. */
function showFace(call) {
  const connected = windows.length > 0
  if (call && callStatus !== 'live' && callStatus !== 'connecting') pendingCall = true
  if (connected) {
    raiseChrome(ourChromePids()[0])
    const newest = windows.at(-1)
    sse(newest, 'command', { cmd: 'raise' })
    if (pendingCall) {
      sse(newest, 'command', { cmd: 'start-call' })
      pendingCall = false
    }
    return { connected: true, opened: false }
  }
  const pids = ourChromePids()
  if (pids.length === 0) launchChrome()
  else raiseChrome(pids[0])
  return { connected: false, opened: pids.length === 0 }
}

function commandNewest(cmd) {
  const newest = windows.at(-1)
  if (newest) sse(newest, 'command', { cmd })
  return Boolean(newest)
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
  const focused = focusedRow()
  sse(res, 'hello', {
    ...rosterPayload(),
    recent: focused?.events ?? [],
    snapshot: focused?.snapshot ?? '',
    call: callStatus,
  })
  for (const older of windows) sse(older, 'command', { cmd: 'superseded' })
  windows.push(res)
  notifyAll({ t: 'window', open: true, count: windows.length })
  if (pendingCall) {
    sse(res, 'command', { cmd: 'start-call' })
    pendingCall = false
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(ping)
    const index = windows.indexOf(res)
    if (index !== -1) windows.splice(index, 1)
    notifyAll({ t: 'window', open: windows.length > 0, count: windows.length })
  })
}

async function fromWindow(body, res) {
  switch (body.type) {
    case 'status':
      callStatus = body.call === 'connecting' || body.call === 'live' || body.call === 'error' ? body.call : 'idle'
      notifyAll({ t: 'status', call: callStatus, mode: body.mode ?? null, error: body.error })
      return sendJson(res, 200, { ok: true })
    case 'line':
      notifyAll({ t: 'line', role: body.role === 'user' ? 'user' : 'agent', text: String(body.text ?? '').slice(0, 2000) })
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
      if (!row.capabilities.has('snapshot')) {
        return sendJson(res, 200, { ok: false, message: `${row.name} can't share a snapshot.` })
      }
      enqueue(row, { id: `cmd_${++commandSeq}`, type: 'snapshot' })
      return sendJson(res, 202, { ok: true })
    }
    case 'send': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      if (!row.capabilities.has('submit')) {
        return sendJson(res, 200, { ok: false, message: `${row.name} can't take a prompt.` })
      }
      const when = body.when === 'now' ? 'now' : 'after_current'
      if (when === 'now' && !row.capabilities.has('steer')) {
        return sendJson(res, 200, { ok: false, message: `${row.name} can't be steered mid-task.` })
      }
      const result = await awaitAck(row, {
        id: `cmd_${++commandSeq}`,
        type: 'send',
        prompt: String(body.prompt ?? '').slice(0, 20_000),
        when,
        summary: String(body.summary ?? '').slice(0, 200),
      })
      return sendJson(res, 200, result)
    }
    case 'stop': {
      const { row, error } = resolveName(body.session)
      if (!row) return sendJson(res, 200, { ok: false, message: error })
      if (!row.capabilities.has('abort')) return sendJson(res, 200, { ok: false, message: `${row.name} can't be stopped from here.` })
      const result = await awaitAck(row, { id: `cmd_${++commandSeq}`, type: 'stop', reason: String(body.reason ?? '').slice(0, 500) })
      return sendJson(res, 200, result)
    }
    default:
      return sendJson(res, 400, { error: 'unknown type' })
  }
}

async function requestToken(id) {
  const res = await fetch(`${ELEVENLABS}/convai/conversation/token?agent_id=${encodeURIComponent(id)}`, {
    headers: { 'xi-api-key': API_KEY },
  })
  return { status: res.status, ok: res.ok, text: await res.text() }
}

async function mintToken() {
  if (!API_KEY) {
    return [503, { error: 'no_api_key', message: 'Set ELEVENLABS_API_KEY (or the api_key option) and restart Claude Code.' }]
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
  if (!res.ok) {
    let detail = res.text.slice(0, 200)
    try {
      const parsed = JSON.parse(res.text).detail
      detail = typeof parsed === 'string' ? parsed : (parsed?.message ?? detail)
    } catch {}
    return [502, { error: 'elevenlabs', message: `ElevenLabs refused the token (${res.status}): ${detail}` }]
  }
  return [200, { token: JSON.parse(res.text).token }]
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

    const sessionRoute = /^\/api\/sessions\/([^/]+)\/(commands|events|ack|bye)$/.exec(url.pathname)
    if (sessionRoute) {
      const row = sessions.get(decodeURIComponent(sessionRoute[1]))
      const authed = sessionFromToken(req)
      // The path id and the token must be the same row. A window key is not enough.
      if (!row || !authed || authed.id !== row.id) return sendJson(res, 401, { error: 'bad session' })
      if (sessionRoute[2] === 'commands' && req.method === 'GET') return pull(row, req, res)
      if (sessionRoute[2] === 'events' && req.method === 'POST') {
        applyEvents(row, await readJson(req))
        return sendJson(res, 200, { ok: true })
      }
      if (sessionRoute[2] === 'ack' && req.method === 'POST') {
        const body = await readJson(req)
        return sendJson(res, 200, { ok: ack(row, body) })
      }
      if (sessionRoute[2] === 'bye' && req.method === 'POST') {
        dropSession(row.id)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { error: 'method' })
    }

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      if (!hasServiceToken(req)) return sendJson(res, 401, { error: 'bad key' })
      const result = subscribe(await readJson(req))
      return sendJson(res, result.status, result.body)
    }
    if (req.method === 'POST' && url.pathname === '/api/window') {
      if (!hasServiceToken(req)) return sendJson(res, 401, { error: 'bad key' })
      const body = await readJson(req)
      const row = sessionFromToken(req)
      if (!row || row.id !== body.sessionId) return sendJson(res, 401, { error: 'bad session' })
      setFocus(row)
      const shown = showFace(Boolean(body.call))
      return sendJson(res, 200, { ok: true, ...shown, name: row.name })
    }
    if (req.method === 'POST' && url.pathname === '/api/call/end') {
      if (!hasServiceToken(req)) return sendJson(res, 401, { error: 'bad key' })
      pendingCall = false
      const delivered = commandNewest('end-call')
      return sendJson(res, 200, { delivered })
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
    broadcast('bye', {})
    process.exit(0)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  port = server.address().port
  persistHub()
  log(`listening on http://127.0.0.1:${port}`)
  if (API_KEY) readyAgent().catch(error => log('agent setup failed:', error?.message ?? error))
})

server.on('error', error => {
  log(error?.code === 'EADDRINUSE' ? `port ${PORT} is taken` : (error?.message ?? error))
  process.exit(1)
})
