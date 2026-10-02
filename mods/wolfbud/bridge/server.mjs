// The WolfBud bridge: the local half of the wolfbud mod.
//
// The mod's hooks run in a sandbox with no DOM, microphone or sockets, so the
// voice call and the 3D wolf live in a browser window, and this server joins
// the two. The mod spawns it for the session's life (node server.mjs) and:
//   - reads its stdout, one `WOLFBUD <json>` line per message (the window's
//     call status, transcript lines, prompts the agent wants to send Claude);
//   - POSTs Claude's activity and its replies to /api/claude, /api/ack and
//     /api/command.
// The window gets the activity over SSE (/api/stream), posts to /api/page,
// and asks /api/token for an ElevenLabs conversation token, so the API key
// never reaches the browser.
//
// Every /api route needs the session key (x-wolfbud-key header or ?k=), and
// only answers to Host/Origin 127.0.0.1 or localhost on its own port: a web
// page elsewhere can't post prompts into Claude's chat.
//
// Env: WOLFBUD_KEY (required), WOLFBUD_PORT (preferred, default 4747),
// ELEVENLABS_API_KEY, WOLFBUD_AGENT_ID (else ../elevenlabs/agent-id.json).

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, timingSafeEqual } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const WINDOW_DIR = resolve(HERE, 'window')
const AGENT_ID_FILE = resolve(HERE, '../elevenlabs/agent-id.json')
const ELEVENLABS = 'https://api.elevenlabs.io/v1'

const KEY = process.env.WOLFBUD_KEY || randomUUID()
const PREFERRED_PORT = Number(process.env.WOLFBUD_PORT) || 4747
const API_KEY = process.env.ELEVENLABS_API_KEY || ''
const MAX_BODY = 256 * 1024
const ACK_TIMEOUT_MS = 15_000
const RECENT_LIMIT = 150

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

/** Claude's recent activity, replayed to a window as it connects. */
const recent = []
/** Open SSE streams, newest last: commands go to the newest window. */
const windows = []
/** Window requests waiting on the mod: id -> { res, timer }. */
const pending = new Map()
let isClaudeBusy = false
/** What the mod says about the session: { project, cwd }. */
let session = {}
let port = 0

function emit(message) {
  process.stdout.write(`WOLFBUD ${JSON.stringify(message)}\n`)
}

function log(...parts) {
  process.stderr.write(`[wolfbud-bridge] ${parts.join(' ')}\n`)
}

function agentId() {
  if (process.env.WOLFBUD_AGENT_ID) return process.env.WOLFBUD_AGENT_ID
  try {
    return JSON.parse(readFileSync(AGENT_ID_FILE, 'utf8')).agentId ?? ''
  } catch {
    return ''
  }
}

function isWindowBuilt() {
  try {
    readFileSync(join(WINDOW_DIR, 'index.html'))
    return true
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function hasKey(req, url) {
  const given = Buffer.from(String(req.headers['x-wolfbud-key'] ?? url.searchParams.get('k') ?? ''))
  const expected = Buffer.from(KEY)
  return given.length === expected.length && timingSafeEqual(given, expected)
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
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(event, data) {
  for (const res of windows) sse(res, event, data)
}

/** Holds a window's request open until the mod acks it (or gives up). */
function awaitAck(res, message) {
  const id = randomUUID()
  const timer = setTimeout(() => {
    pending.delete(id)
    sendJson(res, 504, { ok: false, message: 'Claude Code did not answer in time. Try again in a moment.' })
  }, ACK_TIMEOUT_MS)
  pending.set(id, { res, timer })
  emit({ ...message, id })
}

async function mintToken() {
  if (!API_KEY) {
    return [503, { error: 'no_api_key', message: 'Set ELEVENLABS_API_KEY (or the api_key option) and restart Claude Code.' }]
  }
  const id = agentId()
  if (!id) {
    return [503, { error: 'no_agent', message: 'No agent yet: run `pnpm agent:sync` in the claude-mode-elevenlabs repo.' }]
  }
  const res = await fetch(`${ELEVENLABS}/convai/conversation/token?agent_id=${encodeURIComponent(id)}`, {
    headers: { 'xi-api-key': API_KEY },
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text).detail
      detail = typeof parsed === 'string' ? parsed : parsed?.message ?? detail
    } catch {}
    return [502, { error: 'elevenlabs', message: `ElevenLabs refused the token (${res.status}): ${detail}` }]
  }
  return [200, { token: JSON.parse(text).token }]
}

async function serveStatic(res, pathname) {
  if (!isWindowBuilt()) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>WolfBud</title><body style="font:15px system-ui;padding:24px;background:#141428;color:#e8e8ff">'
      + '<h2>The WolfBud window isn’t built yet</h2><p>In the claude-mode-elevenlabs repo run <code>pnpm install &amp;&amp; pnpm window:build</code>, then reload.</p>')
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
  sse(res, 'hello', { recent, isClaudeBusy, session })
  // One window holds the call: a newer one retires the others.
  for (const older of windows) sse(older, 'command', { cmd: 'superseded' })
  windows.push(res)
  emit({ t: 'window', open: true, count: windows.length })
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(ping)
    windows.splice(windows.indexOf(res), 1)
    emit({ t: 'window', open: windows.length > 0, count: windows.length })
  })
}

/** What the window posts: call status, transcript, and requests for Claude. */
function fromWindow(body, res) {
  switch (body.type) {
    case 'status':
      emit({ t: 'status', call: body.call, mode: body.mode ?? null, error: body.error })
      return sendJson(res, 200, { ok: true })
    case 'line':
      emit({ t: 'line', role: body.role, text: String(body.text ?? '').slice(0, 2000) })
      return sendJson(res, 200, { ok: true })
    case 'snapshot':
      emit({ t: 'snapshot' })
      return sendJson(res, 202, { ok: true })
    case 'send':
      return awaitAck(res, {
        t: 'send',
        prompt: String(body.prompt ?? '').slice(0, 20_000),
        when: body.when === 'now' ? 'now' : 'after_current',
        summary: String(body.summary ?? '').slice(0, 200),
      })
    case 'stop':
      return awaitAck(res, { t: 'stop', reason: String(body.reason ?? '').slice(0, 500) })
    default:
      return sendJson(res, 400, { error: 'unknown type' })
  }
}

/** What the mod posts: Claude's activity, its busy flag, the session's facts, a snapshot. */
function fromClaude(body, res) {
  if (body.session && typeof body.session === 'object') {
    session = body.session
    broadcast('session', session)
  }
  if (typeof body.isClaudeBusy === 'boolean' && body.isClaudeBusy !== isClaudeBusy) {
    isClaudeBusy = body.isClaudeBusy
    broadcast('busy', { isClaudeBusy })
  }
  for (const event of body.events ?? []) {
    recent.push(event)
    if (event.kind === 'turn-start') isClaudeBusy = true
    if (event.kind === 'turn-complete') isClaudeBusy = false
    broadcast('claude', event)
  }
  recent.splice(0, Math.max(0, recent.length - RECENT_LIMIT))
  if (typeof body.snapshot === 'string') broadcast('snapshot', { text: body.snapshot })
  sendJson(res, 200, { ok: true })
}

function ack(body, res) {
  const waiting = pending.get(body.id)
  if (waiting) {
    clearTimeout(waiting.timer)
    pending.delete(body.id)
    sendJson(waiting.res, 200, { ok: Boolean(body.ok), message: String(body.message ?? '') })
  }
  sendJson(res, 200, { ok: Boolean(waiting) })
}

function command(body, res) {
  const newest = windows.at(-1)
  if (newest) sse(newest, 'command', { cmd: body.cmd })
  sendJson(res, 200, { delivered: Boolean(newest) })
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
  if (!hasKey(req, url)) return sendJson(res, 401, { error: 'bad key' })

  try {
    const route = `${req.method} ${url.pathname}`
    switch (route) {
      case 'GET /api/health':
        return sendJson(res, 200, {
          ok: true,
          port,
          hasApiKey: Boolean(API_KEY),
          hasAgent: Boolean(agentId()),
          isWindowBuilt: isWindowBuilt(),
          windows: windows.length,
        })
      case 'GET /api/token': {
        const [status, body] = await mintToken()
        return sendJson(res, status, body)
      }
      case 'GET /api/stream':
        return openStream(req, res)
      case 'POST /api/page':
        return fromWindow(await readJson(req), res)
      case 'POST /api/claude':
        return fromClaude(await readJson(req), res)
      case 'POST /api/ack':
        return ack(await readJson(req), res)
      case 'POST /api/command':
        return command(await readJson(req), res)
      case 'POST /api/quit':
        sendJson(res, 200, { ok: true })
        return void setTimeout(() => process.exit(0), 50)
      default:
        return sendJson(res, 404, { error: 'not found' })
    }
  } catch (error) {
    log('request failed:', error?.message ?? error)
    if (!res.headersSent) sendJson(res, 400, { error: String(error?.message ?? error) })
  }
})

/** Tries the preferred port first (a reload's old bridge may still be letting go), then the next nine. */
async function listen() {
  const candidates = [PREFERRED_PORT, PREFERRED_PORT, PREFERRED_PORT, ...Array.from({ length: 9 }, (_, i) => PREFERRED_PORT + i + 1)]
  for (const candidate of candidates) {
    const error = await new Promise(done => {
      server.once('error', done)
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', done)
        done(null)
      })
    })
    if (!error) return candidate
    if (error.code !== 'EADDRINUSE') throw error
    await new Promise(done => setTimeout(done, 400))
  }
  throw new Error(`ports ${PREFERRED_PORT}-${PREFERRED_PORT + 9} are all taken`)
}

// Leave with Claude Code: the engine kills us on unload, but not if it crashes.
const parentPid = process.ppid
setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    process.exit(0)
  }
}, 2000).unref()

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    broadcast('bye', {})
    process.exit(0)
  })
}

listen()
  .then(bound => {
    port = bound
    emit({ t: 'ready', port, hasApiKey: Boolean(API_KEY), hasAgent: Boolean(agentId()), isWindowBuilt: isWindowBuilt() })
    log(`listening on http://127.0.0.1:${port}`)
  })
  .catch(error => {
    emit({ t: 'fatal', error: String(error?.message ?? error) })
    process.exit(1)
  })
