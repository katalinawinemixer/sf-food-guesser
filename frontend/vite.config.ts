/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const frontendRoot = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  root: frontendRoot,
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5174',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', '../backend/**/*.test.mjs'],
    setupFiles: './src/test/setup.ts',
  },
})
