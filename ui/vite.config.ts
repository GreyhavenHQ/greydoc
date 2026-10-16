import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

// Output goes into the Go module and is embedded with go:embed (internal/server/ui.go).
// emptyOutDir removes the tracked .gitkeep, which go:embed needs when the UI is not built.
function keepOutDir() {
  let outDir = ''
  return {
    name: 'keep-out-dir',
    configResolved(config: { build: { outDir: string } }) {
      outDir = config.build.outDir
    },
    closeBundle() {
      fs.writeFileSync(path.join(outDir, '.gitkeep'), '')
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), keepOutDir()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: '../internal/server/uidist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/auth': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
