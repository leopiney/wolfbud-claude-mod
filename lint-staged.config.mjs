import { existsSync } from 'node:fs'

// The mod's tsconfig extends a file Claude Code writes on every mod load (gitignored),
// so a fresh clone can't type-check the mod until it has been loaded once.
const hasModTypes = existsSync('mods/wolfbud/.claude-plugin/types/tsconfig.json')
if (!hasModTypes) {
  console.warn('lint-staged: skipping the mod type-check; load the mod once (`claude --plugin-dir ./mods/wolfbud`) to generate its types')
}

// tsc checks a whole project, so these ignore the staged file list.
export default {
  '*.{ts,tsx,mjs,js}': ['prettier --write', 'eslint --fix --max-warnings=0 --no-warn-ignored'],
  '*.json': 'prettier --write',
  '{window/**/*.ts,mods/wolfbud/hooks/events.ts}': () => 'tsc -p window',
  'mods/wolfbud/{hooks,tests,types}/**/*.{ts,tsx}': () => (hasModTypes ? 'tsc -p mods/wolfbud' : []),
}
