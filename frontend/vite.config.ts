/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendUrl = 'http://localhost:5170'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // REST endpoints, including GET /healthz.
      '/api': backendUrl,
      '/healthz': backendUrl,
      // Cascade mode's audio channel (see issue #4) will use a WebSocket
      // under /ws; proxied now so the frontend doesn't need re-wiring later.
      '/ws': {
        target: backendUrl,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/__tests__/setup.ts',
  },
})
