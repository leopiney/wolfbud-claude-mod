// Bumps a mod's version when a commit changes what ships, so `claude plugin update`
// sees a new version (an install is a copy cached by version: same version, no update).
// Run by the pre-commit hook, before the window build, since the window shows the version.
//
//   git commit …                      # patch bump, once per branch
//   VERSION_BUMP=minor git commit …   # or major; raises a bump made earlier on the branch
//   VERSION_BUMP=none git commit …    # leave the version alone
//
// "Once per branch": the bump is counted from the version at the merge base with
// origin/main, so every commit of a branch (or of unpushed work on main) ships as one
// release. A version raised by hand above that base is kept.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const LEVELS = ['patch', 'minor', 'major']
const level = (process.env.VERSION_BUMP ?? '').trim().toLowerCase()
if (level === 'none') process.exit(0)
if (level && !LEVELS.includes(level)) {
  console.error(`bump-version: VERSION_BUMP must be one of ${[...LEVELS, 'none'].join(', ')} (got "${level}")`)
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}

/** The mod a staged path ships in, or null when the path doesn't reach users. */
function modOf(path) {
  // The window is built into mods/wolfbud/bridge/window.
  if (path.startsWith('window/')) return 'wolfbud'
  const match = /^mods\/([^/]+)\/(.+)$/.exec(path)
  if (!match) return null
  const [, mod, rest] = match
  // Tests and docs don't change what an install runs. The manifest is what we edit here.
  if (rest.startsWith('tests/') || rest.endsWith('.md') || rest === '.claude-plugin/plugin.json') return null
  return mod
}

const parse = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  return match ? match.slice(1).map(Number) : null
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
function bump([major, minor, patch], how) {
  if (how === 'major') return [major + 1, 0, 0]
  if (how === 'minor') return [major, minor + 1, 0]
  return [major, minor, patch + 1]
}

const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMRD').split('\n').filter(Boolean)
const mods = new Set(staged.map(modOf).filter(Boolean))

const upstream = tryGit('rev-parse', '--verify', '-q', 'origin/main')
const head = tryGit('rev-parse', '--verify', '-q', 'HEAD')
const base = upstream && head ? tryGit('merge-base', head, upstream) : head

for (const mod of mods) {
  const manifest = `mods/${mod}/.claude-plugin/plugin.json`
  const text = readFileSync(manifest, 'utf8')
  const current = parse(JSON.parse(text).version)
  // A new mod (nothing at the base) starts at the version it was written with.
  const released = base ? parse(JSON.parse(tryGit('show', `${base}:${manifest}`) ?? '{}').version) : null
  if (!current || !released) continue

  const target = bump(released, level || 'patch')
  // Without an explicit level, any version above the base already is this branch's bump.
  const isBumped = level ? compare(current, target) >= 0 : compare(current, released) > 0
  if (isBumped) continue

  const next = target.join('.')
  writeFileSync(manifest, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`))
  git('add', manifest)
  console.log(`bump-version: ${mod} ${current.join('.')} → ${next}`)
}
