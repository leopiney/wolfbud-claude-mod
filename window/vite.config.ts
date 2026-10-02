import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The window builds into the mod, where its bridge serves it from.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../mods/wolfbud/bridge/window', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5747 },
})
