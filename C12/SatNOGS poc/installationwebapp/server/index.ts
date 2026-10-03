// Installation server: one shared timeline for every display.
//   /ws        state (timeline, config), clock sync, operator controls
//   /data/...  the downloads folder (images, recordings)
//   /cesium/.. Cesium's workers / textures
//   /          the displays: Vite with hot reload (pnpm dev) or dist/ (pnpm start)
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import sirv from 'sirv'
import { WebSocket, WebSocketServer } from 'ws'
import type { ClientMessage, DisplayInfo, ServerMessage } from '../src/shared/protocol.ts'
import { Conductor } from './conductor.ts'
import { CONFIG_FILE, ROOT, cleanSettings, loadConfig, saveSettings, settingsOf } from './config.ts'
import { libraryInfo, scanPasses, summary } from './manifest.ts'

const PROD = process.argv.includes('--prod')
let cfg = loadConfig()
const DOWNLOADS = path.resolve(ROOT, cfg.downloads) // server, downloads: read once, restart to change
const CESIUM = path.join(ROOT, 'node_modules/cesium/Build/Cesium')
const DIST = path.join(ROOT, 'dist')
const PID_FILE = path.join(ROOT, 'server.pid') // launch.ps1 -Stop

// --- displays
const wss = new WebSocketServer({ noServer: true })
const displays = new Map<WebSocket, DisplayInfo>()
const conductor = new Conductor(cfg)

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

const state = (): ServerMessage => ({
  type: 'state',
  now: Date.now(),
  slots: conductor.slots,
  history: conductor.history,
  config: settingsOf(cfg),
  library: libraryInfo(conductor.passes),
})

const listDisplays = () => broadcast({ type: 'displays', displays: [...displays.values()] })

// --- settings: live from the control page, saved into installation.json; hand edits of
// the file apply live too
let lastWritten = ''
let saveTimer: NodeJS.Timeout | undefined
let reloadTimer: NodeJS.Timeout | undefined

function updateSettings(patch: Record<string, unknown>) {
  const changes = cleanSettings(patch, cfg)
  if (!Object.keys(changes).length) return
  cfg = { ...cfg, ...changes }
  conductor.setConfig(cfg)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      lastWritten = saveSettings(cfg)
    } catch (e) {
      console.error('[settings] not saved:', e)
    }
  }, 500)
}

fs.watch(ROOT, (_event, file) => {
  if (file !== 'installation.json') return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    let text = ''
    try {
      text = fs.readFileSync(CONFIG_FILE, 'utf8')
      if (text === lastWritten) return // our own save
      JSON.parse(text)
    } catch {
      console.error('[settings] installation.json unreadable or not valid JSON, ignored')
      return
    }
    lastWritten = text
    cfg = loadConfig()
    conductor.setConfig(cfg)
    console.log('[settings] installation.json reloaded')
  }, 300)
})

conductor.onChange = () => broadcast(state())

wss.on('connection', (ws, req) => {
  send(ws, state())
  ws.on('message', (data) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong', t0: msg.t0, server: Date.now() })
        break
      case 'hello':
        displays.set(ws, {
          id: msg.id,
          view: msg.view,
          audio: msg.audio,
          address: req.socket.remoteAddress ?? '',
          since: Date.now(),
          errors: 0,
          lastError: null,
        })
        listDisplays()
        break
      case 'library':
        send(ws, { type: 'library', passes: conductor.passes.map(summary) })
        break
      case 'queue':
        conductor.queue(msg.passId)
        break
      case 'settings':
        updateSettings(msg.patch as Record<string, unknown>)
        break
      case 'error': {
        const d = displays.get(ws)
        console.error(`[display ${d?.id ?? '?'}] ${msg.message}`)
        if (d) {
          d.errors++
          d.lastError = String(msg.message).slice(0, 500)
          listDisplays()
        }
        break
      }
      case 'control':
        if (msg.action === 'skip') conductor.skip()
        else if (msg.action === 'restart') conductor.restart()
        else broadcast({ type: 'command', action: msg.action })
        break
    }
  })
  ws.on('close', () => {
    displays.delete(ws)
    listDisplays()
  })
})

// --- http
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void

const serveData = sirv(DOWNLOADS, { dev: true }) // dev: picks up passes downloaded after start
const serveCesium = sirv(CESIUM, { maxAge: 86400 })
let serveClient: Handler | null = null

function notFound(res: http.ServerResponse) {
  res.statusCode = 404
  res.end('not found')
}

// /data/x/y.png -> /x/y.png for the static handler
function mount(prefix: string, handler: Handler, req: http.IncomingMessage, res: http.ServerResponse) {
  req.url = (req.url ?? '/').slice(prefix.length) || '/'
  handler(req, res, () => notFound(res))
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/health') return void res.end('ok')
  if (url.startsWith('/data/')) return mount('/data', serveData, req, res)
  if (url.startsWith('/cesium/')) return mount('/cesium', serveCesium, req, res)
  if (!serveClient) {
    res.statusCode = 503
    return void res.end('starting')
  }
  serveClient(req, res, () => notFound(res))
})

server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  else if (PROD) socket.destroy() // in dev, Vite upgrades its own hot-reload socket
})

if (PROD) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/ is missing: run "pnpm build" first')
    process.exit(1)
  }
  serveClient = sirv(DIST, { single: true })
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ root: ROOT, appType: 'spa', server: { middlewareMode: true, hmr: { server } } })
  serveClient = vite.middlewares
}

// --- timeline
function rescan() {
  try {
    conductor.setPasses(scanPasses(DOWNLOADS))
  } catch (e) {
    console.error('[library]', e)
  }
}
rescan()
setInterval(rescan, 30_000) // listener.py keeps adding passes
setInterval(() => conductor.tick(), 500)

server.listen(cfg.server.port, cfg.server.host, () => {
  fs.writeFileSync(PID_FILE, String(process.pid))
  const host = cfg.server.host === '0.0.0.0' ? 'localhost' : cfg.server.host
  const base = `http://${host}:${cfg.server.port}`
  console.log(`SatNOGS installation${PROD ? '' : ' (dev)'} on ${base}`)
  console.log(`  ${conductor.passes.length} passes from ${DOWNLOADS}`)
  console.log(`  views: ${base}/   operator: ${base}/?view=control`)
})

process.on('exit', () => {
  try {
    fs.unlinkSync(PID_FILE)
  } catch {
    // already gone
  }
})
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
