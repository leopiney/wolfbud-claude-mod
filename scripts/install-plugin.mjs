// One-command install of the WolfBud mod, the same steps as the README:
//
//   ELEVENLABS_API_KEY=… pnpm run install-plugin
//   ELEVENLABS_API_KEY=… pnpm run install-plugin --skip-agent   # keep the ElevenLabs agent as it is
//   pnpm run install-plugin --dry-run                           # print the steps, change nothing
//
// 1. pnpm install            2. pnpm window:build (into mods/wolfbud/bridge/window)
// 3. pnpm agent:sync         4. claude plugin marketplace add <this repo>
// 5. claude plugin install   6. claude plugin configure (the API key, on stdin)
//
// Safe to run again: every step is idempotent, so a re-run also picks up a rebuilt
// window and an edited agent. The key is never printed or put on a command line.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACE = 'elevenlabs-mods'
const PLUGIN = `wolfbud@${MARKETPLACE}`
const MIN_NODE = 20

const flags = new Set(process.argv.slice(2))
const isDryRun = flags.has('--dry-run')
const skipAgent = flags.has('--skip-agent')
const apiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? ''

const TOTAL = skipAgent ? 5 : 6
let stepNumber = 0

function step(title) {
  stepNumber += 1
  console.log(`\n[${stepNumber}/${TOTAL}] ${title}`)
}

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Runs a command with its output streamed; exits the script if it fails. */
function run(command, args, { input } = {}) {
  console.log(`  $ ${[command, ...args].join(' ')}`)
  if (isDryRun) return
  const result = spawnSync(command, args, { cwd: ROOT, input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] })
  if (result.error?.code === 'ENOENT') fail(`\`${command}\` is not installed or not on PATH.`)
  if (result.status !== 0) fail(`\`${[command, ...args].join(' ')}\` failed (exit ${result.status ?? result.signal}).`)
}

console.log(`WolfBud install${isDryRun ? ' (dry run: nothing will be changed)' : ''}`)

// Checks first, so nothing is half-done when something is missing.
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < MIN_NODE) fail(`Node ${MIN_NODE}+ is required (this is ${process.versions.node}).`)
if (!apiKey && !isDryRun) {
  fail('ELEVENLABS_API_KEY is not set. Export it (https://elevenlabs.io/app/settings/api-keys) and run again.')
}
if (!isDryRun) {
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (claude.error || claude.status !== 0) fail('The `claude` CLI is not on PATH. Install Claude Code (>= 2.1.287) first.')
  console.log(`  Claude Code ${claude.stdout.trim()}, Node ${process.versions.node}`)
}

step('Installing dependencies')
run('pnpm', ['install'])

step('Building the call window')
run('pnpm', ['window:build'])

if (!skipAgent) {
  step('Syncing the ElevenLabs voice agent')
  run('pnpm', ['agent:sync'])
}

step('Registering this repo as the Claude Code marketplace')
run('claude', ['plugin', 'marketplace', 'add', ROOT]) // needs an absolute path

step('Installing the plugin')
run('claude', ['plugin', 'install', PLUGIN])

step('Saving the API key to Claude Code (secure storage)')
console.log(`  $ claude plugin configure ${PLUGIN} --values-stdin   (key on stdin)`)
if (!isDryRun) {
  const input = JSON.stringify({ api_key: apiKey })
  const result = spawnSync('claude', ['plugin', 'configure', PLUGIN, '--values-stdin'], {
    cwd: ROOT,
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.status !== 0) fail(`Saving the API key failed (exit ${result.status ?? result.signal}).`)
}

console.log(`\n✔ ${isDryRun ? 'Dry run finished.' : 'WolfBud is installed.'}`)
console.log('  Restart Claude Code, then type /wolfbud call')
console.log(
  '  In Orca it opens the Orca browser, elsewhere a Chrome app window; set the `browser` option to change that (see mods/wolfbud/README.md).',
)
