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

async function ready() {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`hub did not listen\n${stderr}`)
}

function stop() {
  child.kill('SIGTERM')
}

test('a named send reaches only that session', async () => {
  await ready()
  const origin = `http://127.0.0.1:${port}`

  async function subscribe(sessionId, project) {
    const res = await fetch(`${origin}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wolfbud-key': 'service-token' },
      body: JSON.stringify({
        sessionId,
        project,
        cwd: `/repo/${project}`,
        capabilities: ['submit', 'steer', 'abort', 'snapshot'],
      }),
    })
    assert.equal(res.status, 200)
    return res.json()
  }

  const auth = await subscribe('sess-auth', 'auth')
  const shop = await subscribe('sess-shop', 'shop')
  assert.equal(auth.name, 'auth')
  assert.equal(shop.name, 'shop')
  assert.notEqual(auth.token, shop.token)
  assert.notEqual(auth.token, 'service-token')
  assert.notEqual(auth.token, 'window-key')

  const stolen = await fetch(`${origin}/api/sessions/sess-auth/commands`, { headers: { 'x-wolfbud-session': 'window-key' } })
  assert.equal(stolen.status, 401)
  const withService = await fetch(`${origin}/api/sessions/sess-auth/commands`, { headers: { 'x-wolfbud-key': 'service-token' } })
  assert.equal(withService.status, 401)

  const authPoll = fetch(`${origin}/api/sessions/sess-auth/commands`, { headers: { 'x-wolfbud-session': auth.token } })
  await new Promise(resolve => setTimeout(resolve, 50))

  const sent = fetch(`${origin}/api/page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wolfbud-key': 'window-key' },
    body: JSON.stringify({ type: 'send', session: 'auth', prompt: 'Add a test for the login form.', when: 'after_current', summary: 'Add a login test' }),
  })

  const authBody = await (await authPoll).json()
  assert.equal(authBody.commands.length, 1)
  assert.equal(authBody.commands[0].type, 'send')
  assert.equal(authBody.commands[0].prompt, 'Add a test for the login form.')
  assert.equal(authBody.commands[0].when, 'after_current')

  const shopBody = await (await fetch(`${origin}/api/sessions/sess-shop/commands`, { headers: { 'x-wolfbud-session': shop.token } })).json()
  assert.deepEqual(shopBody.commands, [])

  const acked = await fetch(`${origin}/api/sessions/sess-auth/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wolfbud-session': auth.token },
    body: JSON.stringify({ id: authBody.commands[0].id, ok: true, message: 'Sent: Claude is starting on it now.' }),
  })
  assert.equal(acked.status, 200)
  const tool = await (await sent).json()
  assert.deepEqual(tool, { ok: true, message: 'Sent: Claude is starting on it now.' })

  const enqueueAsSession = await fetch(`${origin}/api/page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wolfbud-key': auth.token },
    body: JSON.stringify({ type: 'send', session: 'shop', prompt: 'nope', when: 'now', summary: 'nope' }),
  })
  assert.equal(enqueueAsSession.status, 401)
})

test.after(() => stop())
process.on('exit', stop)
void once(child, 'exit')
