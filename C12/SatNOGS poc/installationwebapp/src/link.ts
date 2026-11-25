import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AfterLos, CenitTest, ClientMessage, DisplayInfo, GhostTest, LiveReading, LiveSample, PassSummary, ServerMessage, Slot, StateMessage } from './shared/protocol.ts'
import { AUDIO, DISPLAY_ID, VIEW } from './params.ts'

const clientNow = () => performance.timeOrigin + performance.now()

// The display's connection to the installation server: the shared timeline, operator
// commands, and the server's clock (NTP style: offset from the ping with the shortest
// round trip), so every display computes the same "now".
class Link {
  state: StateMessage | null = null
  displays: DisplayInfo[] = []
  library: PassSummary[] = []
  connected = false
  identifyUntil = 0
  ghostTests: GhostTest[] = [] // the last 20 s of them (components/Ghosts.tsx)
  cenitTests: CenitTest[] = [] // the last few (components/Cenit.tsx)
  live: LiveReading | null = null // the real receiver's latest, during a live slot
  liveSamples: LiveSample[] = [] // the live pass's, a second each, oldest first
  afterLos: Record<number, AfterLos> = {} // the live passes past LOS: the Pi decoding them, or done
  // the receiver's latest spectrum (0..255 per bin); kept without re-rendering: the views that show
  // it read it every frame
  spectrum: { t: number; bins: Uint8Array; frequency: number | null; samplerate: number | null } | null = null
  private offset = 0
  private samples: { rtt: number; offset: number }[] = []
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private version = 0

  constructor() {
    this.open()
    setInterval(() => this.ping(), 2000)
  }

  // server time, epoch ms
  now() {
    return clientNow() + this.offset
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  private ping() {
    this.send({ type: 'ping', t0: clientNow() })
  }

  private open() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.samples = []
      this.send({ type: 'hello', id: DISPLAY_ID, view: VIEW, audio: AUDIO })
      for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 150)
      this.emit()
    }
    ws.onmessage = (e) => this.receive(JSON.parse(e.data) as ServerMessage)
    ws.onclose = () => {
      this.connected = false
      this.emit()
      setTimeout(() => this.open(), 2000)
    }
  }

  private receive(msg: ServerMessage) {
    switch (msg.type) {
      case 'pong': {
        const t1 = clientNow()
        this.samples.push({ rtt: t1 - msg.t0, offset: msg.server - (msg.t0 + t1) / 2 })
        if (this.samples.length > 10) this.samples.shift()
        this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset
        return
      }
      case 'state':
        this.state = msg
        if (!this.samples.length) this.offset = msg.now - clientNow() // until the first pong
        break
      case 'displays':
        this.displays = msg.displays
        break
      case 'library':
        this.library = msg.passes
        break
      case 'command':
        if (msg.ids && !msg.ids.includes(DISPLAY_ID)) break // meant for other displays
        if (msg.action === 'reload') location.reload()
        if (msg.action === 'identify') this.identifyUntil = Date.now() + 6000
        break
      case 'afterlos':
        this.afterLos = msg.passes
        break
      case 'live':
        this.live = msg.reading
        this.liveSamples = msg.reset ? [...msg.samples] : [...this.liveSamples, ...msg.samples].slice(-3600)
        break
      case 'spectrum': {
        const raw = atob(msg.bins)
        const bins = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bins[i] = raw.charCodeAt(i)
        this.spectrum = { t: msg.t, bins, frequency: msg.frequency, samplerate: msg.samplerate }
        return // no re-render, 4 a second
      }
      case 'cenit':
        this.cenitTests = [...this.cenitTests.slice(-4), { at: msg.at }]
        break
      case 'ghost':
        this.ghostTests = [...this.ghostTests.filter((x) => x.at > msg.at - 20_000), { kinds: msg.kinds, at: msg.at, seed: msg.seed }]
        break
    }
    this.emit()
  }
}

export const link = new Link()

// re-renders on every server message
export function useLink() {
  useSyncExternalStore(link.subscribe, link.getVersion)
  return link
}

// re-renders every `ms` (clocks, countdowns); returns the server time
export function useTicker(ms: number) {
  const [, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
  return link.now()
}

// the latest version of a slot (skip / restart re-time it), null once it's over
export function liveSlot(id: number | null): Slot | null {
  if (id == null) return null
  return link.state?.slots.find((s) => s.id === id) ?? null
}
