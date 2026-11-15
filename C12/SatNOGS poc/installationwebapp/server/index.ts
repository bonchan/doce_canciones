// Installation server: one shared timeline for every display.
//   /ws        state (timeline, config), clock sync, operator controls
//   /data/...  the downloads folder (images, recordings)
//   /cesium/.. Cesium's workers / textures
//   /          the displays: Vite with hot reload (pnpm dev) or dist/ (pnpm start)
//   /api/...   displays and commands, for the computers' agents (../agent)
// and, with "mqtt" enabled in installation.json, a device on core2's bus (device.ts)
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import sirv from 'sirv'
import { WebSocket, WebSocketServer } from 'ws'
import type { ClientMessage, DisplayInfo, ServerMessage } from '../src/shared/protocol.ts'
import { phaseAt, progressAt } from '../src/timeline.ts'
import { Conductor } from './conductor.ts'
import { CONFIG_FILE, ROOT, cleanSettings, loadConfig, saveSettings, settingsOf } from './config.ts'
import { startDevice, type Device } from './device.ts'
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

// reload / identify, for every display or only some (the agents ask for their own screens')
function command(action: 'reload' | 'identify', ids?: string[]) {
  broadcast({ type: 'command', action, ...(ids?.length ? { ids } : {}) })
}

// a display is showing while its health reports keep coming, say it's on screen and drawing
const showing = (d: DisplayInfo) =>
  d.health != null && Date.now() - d.health < 8000 && d.visible !== false && (d.fps ?? 0) >= 5

// the pages that aren't displays (operator, menu, the grid around its cells)
const NOT_DISPLAYS = new Set(['', 'control', 'grid'])
const screens = () => [...displays.values()].filter((d) => !NOT_DISPLAYS.has(d.view))

const displayReport = (d: DisplayInfo) => ({
  id: d.id,
  view: d.view,
  audio: d.audio,
  address: d.address,
  showing: showing(d),
  fps: d.fps,
  visible: d.visible,
  errors: d.errors,
  last_error: d.lastError,
})

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
          fps: null,
          visible: null,
          health: null,
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
      case 'health': {
        const d = displays.get(ws)
        if (d) {
          d.fps = Number.isFinite(msg.fps) ? msg.fps : null
          d.visible = !!msg.visible
          d.health = Date.now()
        }
        break
      }
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
        else command(msg.action)
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

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

// For the agents on the display computers: which displays are connected and drawing, and
// reload / identify for their own screens. On the local network, no key, like the displays.
function api(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
  if (req.method === 'GET' && url === '/api/displays') return json(res, 200, screens().map(displayReport))
  if (req.method === 'POST' && url === '/api/command') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const { action, ids } = JSON.parse(body || '{}')
        if (action !== 'reload' && action !== 'identify') return json(res, 400, { error: 'action: reload or identify' })
        command(action, Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === 'string') : undefined)
        json(res, 200, { ok: true })
      } catch {
        json(res, 400, { error: 'invalid JSON' })
      }
    })
    return
  }
  json(res, 404, { error: 'not found' })
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/health') return void res.end('ok')
  if (url.startsWith('/api/')) return api(req, res, url.split('?')[0])
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

// --- core2's MQTT bus: this installation as a device of type installation.satnogs
let device: Device | null = null

// the display languages (src/lang/*.json), for core2's page to offer them
function languages() {
  const dir = path.join(ROOT, 'src/lang')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const code = f.slice(0, -5)
      try {
        return { code, name: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name ?? code }
      } catch {
        return { code, name: code }
      }
    })
}

function telemetry() {
  const t = Date.now()
  const i = conductor.slots.findIndex((s) => t < s.end)
  const on = i >= 0 ? conductor.slots[i] : null
  const next = i >= 0 ? conductor.slots[i + 1] : undefined
  const lib = libraryInfo(conductor.passes)
  const list = screens()
  const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))
  return {
    phase: on ? phaseAt(on, t) : 'idle',
    satellite: on?.pass.satellite ?? null,
    station: on?.pass.station_name ?? null,
    progress: on ? Math.round(progressAt(on, t) * 100) : 0,
    aos_in: on ? seconds(on.aos - t) : null,
    los_in: on ? seconds(on.los - t) : null,
    next_satellite: next?.pass.satellite ?? null,
    next_aos_in: next ? seconds(next.aos - t) : null,
    speed: cfg.speed,
    language: cfg.language,
    phrases: cfg.phrases,
    hide_cursor: cfg.hideCursor,
    imagery: cfg.imagery,
    location: cfg.location,
    volume: cfg.volume,
    passes: lib.passes,
    stations: lib.stations,
    displays_connected: list.length,
    displays_showing: list.filter(showing).length,
    displays: list.map(displayReport),
    uptime: Math.round(process.uptime()),
  }
}

function onCommand(capability: string, p: Record<string, unknown>) {
  const ids = Array.isArray(p.ids) ? p.ids.filter((x): x is string => typeof x === 'string') : undefined
  switch (capability) {
    case 'SKIP':
      return conductor.skip()
    case 'RESTART':
      return conductor.restart()
    case 'RELOAD':
      return command('reload', ids)
    case 'IDENTIFY':
      return command('identify', ids)
    case 'SETTINGS': // the same fields as the operator page's Settings, e.g. {"speed": 4}
      return updateSettings(p)
    case 'QUEUE':
      if (typeof p.pass_id === 'number') conductor.queue(p.pass_id)
      return
  }
}

if (cfg.mqtt.enabled) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  device = startDevice({
    ...cfg.mqtt,
    type: 'installation.satnogs',
    fw: pkg.version,
    publishes: Object.keys(telemetry()),
    subscribes: ['SKIP', 'RESTART', 'RELOAD', 'IDENTIFY', 'SETTINGS', 'QUEUE'],
    announceExtra: () => ({
      languages: languages(),
      satellites: Object.keys(libraryInfo(conductor.passes).satellites).sort(),
    }),
    telemetry,
    onCommand,
  })
}

// --- timeline
let satelliteList = ''
function rescan() {
  try {
    conductor.setPasses(scanPasses(DOWNLOADS))
    const satellites = Object.keys(libraryInfo(conductor.passes).satellites).sort().join()
    if (satellites !== satelliteList) device?.announce() // core2's page offers them
    satelliteList = satellites
  } catch (e) {
    console.error('[library]', e)
  }
}
rescan()
setInterval(rescan, 30_000) // listener.py keeps adding passes
setInterval(() => conductor.tick(), 500)
setInterval(listDisplays, 5000) // the operator page's fps / showing

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
// a moment for the MQTT goodbye ("offline") to go out
process.on('SIGINT', () => setTimeout(() => process.exit(0), 300))
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300))
