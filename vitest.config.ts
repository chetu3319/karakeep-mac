import { defineConfig } from 'vitest/config'

// Tests cover the pure modules only (no DOM, no Electron), so the plain node
// environment is enough. electron-vite never sees these files: it bundles from
// its entry points, and nothing imports a *.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
