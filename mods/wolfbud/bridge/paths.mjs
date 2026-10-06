// Where the hub keeps its files, shared by server.mjs and launch.mjs.
// ~/.wolfbud holds the hub record, the agent record, the Chrome profile and
// the hub log, all private to the user.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Fixed: Chrome's mic grant is per origin, so the port does not walk.
export const DEFAULT_PORT = 4747

export const WOLF_DIR = join(process.env.HOME || homedir(), '.wolfbud')
export const HUB_PATH = join(WOLF_DIR, 'hub.json')
export const AGENT_PATH = join(WOLF_DIR, 'agent.json')
export const CHROME_DIR = join(WOLF_DIR, 'chrome')
export const LOG_PATH = join(WOLF_DIR, 'hub.log')

export function ensureWolfDir() {
  mkdirSync(WOLF_DIR, { recursive: true, mode: 0o700 })
}

/** The parsed file, or null when it is missing or not JSON. */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Writes `value` as JSON readable by this user only. */
export function writePrivateJson(path, value) {
  ensureWolfDir()
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}
