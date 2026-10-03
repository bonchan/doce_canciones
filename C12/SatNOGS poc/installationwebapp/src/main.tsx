import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import { App } from './App.tsx'
import './errors.ts' // reports uncaught errors to the server
import './theme.css'

declare global {
  interface Window {
    CESIUM_BASE_URL: string
  }
}
// Cesium loads its workers / textures from here (served by server/index.ts)
window.CESIUM_BASE_URL = '/cesium/'

createRoot(document.getElementById('root')!).render(<App />)
