// Starts the WolfBud hub and exits. The mod runs this and forgets it.
//
// The hub must not be a child of Claude: the engine kills those, and a second
// session would otherwise spawn a second bridge. This process spawns
// `server.mjs` detached (its own session) and leaves. A hub already answering
// /api/health is left alone, so a later /wolfbud does not open another Chrome.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 4747
const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.mjs')
const DIR = join(process.env.HOME || homedir(), '.wolfbud')
const HUB = join(DIR, 'hub.json')
const LOCK = join(DIR, 'launch.lock')
const LOG = join(DIR, 'hub.log')

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(400) })
    return res.ok
  } catch {
    return false
  }
}

function readHub() {
  try {
    return JSON.parse(readFileSync(HUB, 'utf8'))
  } catch {
    return null
  }
}

function writeHub(hub) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(HUB, `${JSON.stringify(hub)}\n`, { mode: 0o600 })
}

async function waitHealthy(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await healthy()) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

if (await healthy()) process.exit(0)

mkdirSync(DIR, { recursive: true, mode: 0o700 })

let lock
try {
  lock = openSync(LOCK, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
} catch {
  process.exit((await waitHealthy(8000)) ? 0 : 1)
}

let code = 0
try {
  if (!(await healthy())) {
    const existing = readHub()
    const hub = {
      port: PORT,
      pid: 0,
      token: typeof existing?.token === 'string' && existing.token !== '' ? existing.token : randomUUID(),
      windowKey: typeof existing?.windowKey === 'string' && existing.windowKey !== '' ? existing.windowKey : randomUUID(),
    }
    const logFd = openSync(LOG, 'a', 0o600)
    const child = spawn(process.execPath, [SERVER], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        WOLFBUD_PORT: String(PORT),
        WOLFBUD_TOKEN: hub.token,
        WOLFBUD_WINDOW_KEY: hub.windowKey,
      },
    })
    child.unref()
    hub.pid = child.pid ?? 0
    writeHub(hub)
    closeSync(logFd)
    code = (await waitHealthy(8000)) ? 0 : 1
  }
} finally {
  try {
    closeSync(lock)
  } catch {}
  try {
    unlinkSync(LOCK)
  } catch {}
}

process.exit(code)
