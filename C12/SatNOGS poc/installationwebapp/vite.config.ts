import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The displays only: server/index.ts serves them (as middleware with `pnpm dev`, from dist/
// with `pnpm start`) together with /data, /cesium and the /ws socket.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 8000 },
})
