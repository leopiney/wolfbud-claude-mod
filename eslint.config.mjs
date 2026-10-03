import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      // Built by `pnpm window:build`; the bridge serves it
      'mods/wolfbud/bridge/window/',
      // Written by Claude Code on every mod load
      'mods/*/.claude-plugin/types/',
      // Demo video renders and media
      'video/out/',
      'video/public/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['window/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.mjs', 'window/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // Best-effort calls (localStorage, parsing an error body) swallow on purpose.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
