import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The window has no package.json of its own; the mod's manifest holds the app's version.
const { version } = JSON.parse(readFileSync(new URL('../mods/wolfbud/.claude-plugin/plugin.json', import.meta.url), 'utf8')) as {
  version: string
}

// The window builds into the mod, where its bridge serves it from.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: fileURLToPath(new URL('../mods/wolfbud/bridge/window', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5747 },
})
