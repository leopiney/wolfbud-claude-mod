// Starts the WolfBud hub and exits. The mod runs this and forgets it.
//
// The hub must not be a child of Claude: the engine kills those, and a second
// session would otherwise spawn a second bridge. This process spawns
// `server.mjs` detached (its own session) and leaves once /api/health answers.
// The server owns its tokens and ~/.wolfbud/hub.json, and exits quietly when
// another hub already holds the port, so two launchers racing is harmless.

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORT, LOG_PATH, ensureWolfDir } from './paths.mjs'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`, { signal: AbortSignal.timeout(400) })
    return res.ok
  } catch {
    return false
  }
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

ensureWolfDir()
const logFd = openSync(LOG_PATH, 'a', 0o600)
spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env }).unref()
closeSync(logFd)

process.exit((await waitHealthy(8000)) ? 0 : 1)
