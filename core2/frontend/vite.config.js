import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The backend `pnpm dev` forwards /api and /ws to: this machine by default, or e.g.
  // VITE_BACKEND=http://nuc.local:8000 in .env.local to work on the page against the NUC.
  const backend = loadEnv(mode, '.', '').VITE_BACKEND || 'http://127.0.0.1:8000'
  return {
    plugins: [react()],
    server: {
      host: true,   // every address, IPv4 and IPv6: open the dev server from other computers too
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    },
  }
})
