// Two Claude sessions, one hub, one window key. A prompt named for a short
// session lands in that session's inbox and nowhere else. Run: node --test bridge/hub.test.mjs

import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'wolfbud-hub-'))
const port = 18000 + Math.floor(Math.random() * 20000)
const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  env: {
    ...process.env,
    HOME: home,
    ELEVENLABS_API_KEY: '',
    WOLFBUD_AGENT_ID: '',
    WOLFBUD_PORT: String(port),
    WOLFBUD_TOKEN: 'service-token',
    WOLFBUD_WINDOW_KEY: 'window-key',
    WOLFBUD_NO_WINDOW: '1',
    WOLFBUD_POLL_MS: '80',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr?.on('data', chunk => {
  stderr += String(chunk)
})

const origin = `http://127.0.0.1:${port}`

async function ready() {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    try {
      const res = await fetch(`${origin}/api/health`)
      if (res.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`hub did not listen\n${stderr}`)
}

function stop() {
  child.kill('SIGTERM')
}

const json = (body, headers) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const asSession = token => ({ headers: { 'x-wolfbud-session': token } })
const asWindow = body => json(body, { 'x-wolfbud-key': 'window-key' })

async function subscribe(sessionId, project) {
  const res = await fetch(`${origin}/api/subscribe`, json({ sessionId, project }, { 'x-wolfbud-key': 'service-token' }))
  assert.equal(res.status, 200)
  return res.json()
}

test('a named send reaches only that session', async () => {
  await ready()

  const auth = await subscribe('sess-auth', 'auth')
  const shop = await subscribe('sess-shop', 'shop')
  assert.equal(auth.name, 'auth')
  assert.equal(shop.name, 'shop')
  assert.notEqual(auth.token, shop.token)
  assert.notEqual(auth.token, 'service-token')
  assert.notEqual(auth.token, 'window-key')

  // Only a session token pulls an inbox.
  assert.equal((await fetch(`${origin}/api/session/commands`, asSession('window-key'))).status, 401)
  assert.equal((await fetch(`${origin}/api/session/commands`, asSession('service-token'))).status, 401)
  assert.equal((await fetch(`${origin}/api/session/commands`, { headers: { 'x-wolfbud-key': 'service-token' } })).status, 401)

  const authPoll = fetch(`${origin}/api/session/commands`, asSession(auth.token))
  await new Promise(resolve => setTimeout(resolve, 50))

  const sent = fetch(
    `${origin}/api/page`,
    asWindow({
      type: 'send',
      session: 'auth',
      prompt: 'Add a test for the login form.',
      when: 'after_current',
      summary: 'Add a login test',
    }),
  )

  const authBody = await (await authPoll).json()
  assert.equal(authBody.commands.length, 1)
  assert.equal(authBody.commands[0].type, 'send')
  assert.equal(authBody.commands[0].prompt, 'Add a test for the login form.')
  assert.equal(authBody.commands[0].when, 'after_current')
  assert.deepEqual(authBody.call, { status: 'idle', mode: null, error: null })
  assert.equal(authBody.isWindowOpen, false)

  const shopBody = await (await fetch(`${origin}/api/session/commands`, asSession(shop.token))).json()
  assert.deepEqual(shopBody.commands, [])

  const acked = await fetch(
    `${origin}/api/session/ack`,
    json({ id: authBody.commands[0].id, ok: true, message: 'Sent: Claude is starting on it now.' }, asSession(auth.token).headers),
  )
  assert.equal(acked.status, 200)
  assert.deepEqual(await (await sent).json(), { ok: true, message: 'Sent: Claude is starting on it now.' })

  // A session token cannot enqueue for another session.
  const enqueueAsSession = await fetch(
    `${origin}/api/page`,
    json({ type: 'send', session: 'shop', prompt: 'nope', when: 'now', summary: 'nope' }, { 'x-wolfbud-key': auth.token }),
  )
  assert.equal(enqueueAsSession.status, 401)
})

test('the call state rides on every pull, and a line reaches every session', async () => {
  await ready()
  const auth = await subscribe('sess-auth', 'auth')
  const shop = await subscribe('sess-shop', 'shop')

  const shopPoll = fetch(`${origin}/api/session/commands`, asSession(shop.token))
  await new Promise(resolve => setTimeout(resolve, 50))
  await fetch(`${origin}/api/page`, asWindow({ type: 'status', call: 'live', mode: 'listening' }))
  const shopBody = await (await shopPoll).json()
  assert.deepEqual(shopBody.call, { status: 'live', mode: 'listening', error: null })
  assert.deepEqual(shopBody.lines, [])

  await fetch(`${origin}/api/page`, asWindow({ type: 'line', role: 'user', text: 'can we rename that button?' }))
  const authBody = await (await fetch(`${origin}/api/session/commands`, asSession(auth.token))).json()
  assert.deepEqual(authBody.lines, [{ role: 'user', text: 'can we rename that button?' }])
  assert.equal(authBody.call.status, 'live')
})

test('the roster says where each session runs', async () => {
  await ready()
  await subscribe('sess-auth', 'auth')
  const res = await fetch(
    `${origin}/api/subscribe`,
    json({ sessionId: 'sess-box', project: 'box', isRemote: true, host: 'sandbox-7' }, { 'x-wolfbud-key': 'service-token' }),
  )
  assert.equal(res.status, 200)

  const stream = new AbortController()
  const opened = await fetch(`${origin}/api/stream`, { headers: { 'x-wolfbud-key': 'window-key' }, signal: stream.signal })
  const reader = opened.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
  stream.abort()
  const hello = JSON.parse(/^data: (.*)$/m.exec(text)[1])
  const where = Object.fromEntries(hello.rows.map(row => [row.id, { isRemote: row.isRemote, host: row.host }]))
  assert.deepEqual(where['sess-auth'], { isRemote: false, host: '' })
  assert.deepEqual(where['sess-box'], { isRemote: true, host: 'sandbox-7' })
})

test.after(() => stop())
process.on('exit', stop)
void once(child, 'exit')
