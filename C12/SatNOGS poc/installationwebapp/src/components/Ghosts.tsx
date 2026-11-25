import { useEffect, useRef } from 'react'
import { random, textSeed } from '../art/phrases.ts'
import { skyFor } from '../art/sky.ts'
import { useSky } from '../art/skyImages.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { CAMERA, DISPLAY_ID, VIEW } from '../params.ts'
import { GHOST_DEFAULTS, GHOST_FAMILY, GHOST_KINDS, type GhostKind, type GhostsSettings } from '../shared/ghosts.ts'
import type { GhostTest, Slot } from '../shared/protocol.ts'
import { activeSlot, geometryFor, satTimeAt } from '../timeline.ts'
import { cenitWidth } from './Cenit.tsx'

// Reception ghosts. While a pass with a sky photo is on air the signal breaks up now and then,
// and pieces of the photo come through where the picture should be: the sky from below leaking
// into the satellite's signal.
// They break up the way the pass's radio would. Analog (NOAA, APT): lines torn sideways with
// their colours split, a faint copy of the picture echoing a little to the right, the frame
// rolling, all with scanlines. Digital (METEOR, LRPT): runs of 8 x 8 blocks from the wrong
// place, a row of blocks with its last line dragged down, the photo surfacing in scattered blocks.
// Each kind comes on its own, with its own settings (`ghosts`, src/shared/ghosts.ts): when it
// appears (by default the more the weaker the signal: often with the satellite low over the
// horizon, at AOS and LOS, seldom with it overhead), how often and how strongly. But only one
// at a time: one that would start while another is on doesn't happen (chainTo).
// Every display breaks up at the same instant, each with pieces of its own. A ghost is worked
// out from the time, the pass and the settings alone, so nothing has to be sent. `ghostsOn` off:
// none at all (the kinds keep their settings).
// Tests (the operator page, core2's GHOST): a kind right now on every display, at its prominence,
// whatever its settings say about when, with the master switch off too, and on a pass without a
// sky photo (then with the one it would have had at 100%). Several kinds: one after another.

const TICK_MS = 200 // a ghost can start in any of these
const QUIET = 0.125 // 'low' / 'high': how often at the quiet end, against the busy one
const SCALE = 0.5 // the ghosts' pixels: two of the screen's each way, a little coarse
const BLOCK = 8 // the digital blocks, in the ghosts' pixels (JPEG's 8 x 8)
const JITTER_MS = 50 // the torn lines jump this often

// how long each lasts: shortest, longest (ms)
const LASTS: Record<GhostKind, [number, number]> = {
  tear: [80, 350],
  echo: [500, 1400],
  roll: [300, 800],
  blocks: [150, 600],
  smear: [200, 700],
  mosaic: [500, 1400],
}
const MAX_MS = Math.max(...Object.values(LASTS).map(([, max]) => max))

interface Ghost {
  kind: GhostKind
  start: number // server time, ms
  ms: number
  seed: number // the same on every display
  weak: number // how weak the signal was: 0 (the satellite overhead) to 1 (at the horizon)
  p: number // prominence: 1 as designed, 0 to 2
}

const DISPLAY_SEED = textSeed(DISPLAY_ID)
const mix = (a: number, b: number) => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35)) >>> 0
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// how weak the signal is at t: 0 with the satellite at its highest, 1 at the horizon
function weakness(s: Slot, t: number): number {
  const config = link.state?.config
  if (!config) return 0
  const g = geometryFor(s.pass, config)
  const top = g.look(0).elevation
  const el = g.look(satTimeAt(s, g, t)).elevation
  return top > 0 ? 1 - clamp(el / top, 0, 1) : 1
}

// the ghosts that would start in tick k (the same on every display): each kind of the pass's
// radio rolls on its own, in the order they'd start
function bornIn(s: Slot, k: number, settings: GhostsSettings): Ghost[] {
  const out: Ghost[] = []
  const at = k * TICK_MS
  if (at < s.aos || at >= s.los) return out
  const family = s.pass.audio ? 'NOAA' : 'METEOR'
  let weak: number | null = null
  for (const [i, kind] of GHOST_KINDS.entries()) {
    const set = settings[kind] ?? GHOST_DEFAULTS[kind]
    if (GHOST_FAMILY[kind] !== family || set.appear === 'off' || set.prominence <= 0) continue
    weak ??= weakness(s, at)
    const busy = set.appear === 'low' ? weak * weak : set.appear === 'high' ? (1 - weak) ** 2 : 1
    const perSecond = (QUIET + (1 - QUIET) * busy) / Math.max(0.1, set.delay)
    const r = random(mix(mix(s.id, k), i))
    if (r() >= 1 - Math.exp((-perSecond * TICK_MS) / 1000)) continue
    const [min, max] = LASTS[kind]
    out.push({
      kind,
      start: at + r() * TICK_MS,
      ms: min + r() * (max - min),
      seed: (r() * 2 ** 32) >>> 0,
      weak,
      p: set.prominence / 100,
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

// One ghost at a time: a pass's ghosts worked out tick by tick from its AOS, and any that would
// start while another is still on dropped. Always from AOS, so every display drops the same
// ones, whenever it joined. Kept per pass and settings (a change starts it over).
interface Chain {
  next: number // the next tick to work out
  busyUntil: number // the last ghost's end
  ghosts: Ghost[] // the ones that happen, in order
}
const chains = new WeakMap<GhostsSettings, Map<string, Chain>>()

function chainTo(s: Slot, t: number, settings: GhostsSettings): Chain {
  let bySlot = chains.get(settings)
  if (!bySlot) chains.set(settings, (bySlot = new Map()))
  const key = `${s.id}|${s.aos}|${s.los}`
  let chain = bySlot.get(key)
  if (!chain) {
    if (bySlot.size > 4) bySlot.clear()
    chain = { next: Math.ceil(s.aos / TICK_MS), busyUntil: -Infinity, ghosts: [] }
    bySlot.set(key, chain)
  }
  const last = Math.min(Math.floor(t / TICK_MS), Math.ceil(s.los / TICK_MS))
  for (; chain.next <= last; chain.next++) {
    for (const g of bornIn(s, chain.next, settings)) {
      if (g.start < chain.busyUntil) continue // another one is on
      chain.ghosts.push(g)
      chain.busyUntil = g.start + g.ms
    }
  }
  return chain
}

// the ghost showing at t, if any
function ghostsAt(s: Slot, t: number): Ghost[] {
  const { ghosts } = chainTo(s, t, link.state?.config.ghosts ?? GHOST_DEFAULTS)
  for (let i = ghosts.length - 1; i >= 0 && ghosts[i].start + MAX_MS > t; i--) {
    const g = ghosts[i]
    if (t >= g.start && t < g.start + g.ms) return [g]
  }
  return []
}

// The tests showing at t, one at a time too: a test of several kinds plays them one after
// another, and a test asked for while another is on waits for it. Each starts when asked for,
// the same instant on every display, or, on a display still decoding the photo, as soon as it
// has it. As long as the kind lasts at most.
const TEST_GAP_MS = 250 // between the kinds of one test
const tested = new WeakMap<GhostTest, Ghost[]>()

function testsAt(t: number, s: Slot | null): Ghost[] {
  const out: Ghost[] = []
  let busyUntil = -Infinity
  for (const test of link.ghostTests) {
    let ghosts = tested.get(test)
    if (!ghosts) {
      if (t > test.at + 20_000) continue // too late for it
      const settings = link.state?.config.ghosts ?? GHOST_DEFAULTS
      // the signal right then if a pass is on air, else halfway
      const weak = s && test.at >= s.aos && test.at < s.los ? weakness(s, test.at) : 0.5
      let start = Math.max(test.at, t, busyUntil + TEST_GAP_MS)
      ghosts = test.kinds.map((kind, i) => {
        const g = {
          kind,
          start,
          ms: LASTS[kind][1],
          seed: mix(test.seed, i),
          weak,
          p: (settings[kind] ?? GHOST_DEFAULTS[kind]).prominence / 100,
        }
        start += g.ms + TEST_GAP_MS
        return g
      })
      tested.set(test, ghosts)
    }
    for (const g of ghosts) {
      if (t >= g.start && t < g.start + g.ms) out.push(g)
      busyUntil = Math.max(busyUntil, g.start + g.ms)
    }
  }
  return out
}

// The photo over the whole screen (cover), at the ghosts' size, and split in two for the torn
// lines: its red, and its green and blue (the two added together are the photo again).
interface Layers {
  W: number
  H: number
  photo: HTMLCanvasElement
  red: HTMLCanvasElement
  cyan: HTMLCanvasElement
}

function layersFor(image: ImageBitmap, W: number, H: number): Layers {
  const photo = document.createElement('canvas')
  photo.width = W
  photo.height = H
  const k = Math.max(W / image.width, H / image.height)
  photo.getContext('2d')!.drawImage(image, (W - image.width * k) / 2, (H - image.height * k) / 2, image.width * k, image.height * k)
  const only = (color: string) => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const x = c.getContext('2d')!
    x.drawImage(photo, 0, 0)
    x.globalCompositeOperation = 'multiply'
    x.fillStyle = color
    x.fillRect(0, 0, W, H)
    return c
  }
  return { W, H, photo, red: only('#f00'), cyan: only('#0ff') }
}

// every other line a little dark (cut out of the ghosts)
function scanTile() {
  const c = document.createElement('canvas')
  c.width = 1
  c.height = 2
  const x = c.getContext('2d')!
  x.fillStyle = 'rgba(0, 0, 0, 0.5)'
  x.fillRect(0, 1, 1, 1)
  return c
}

// lines sy..sy+h of a picture, drawn at dy shifted sideways by dx, wrapping round
function row(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, sy: number, h: number, dy: number, dx: number) {
  const W = img.width
  const x = ((Math.round(dx) % W) + W) % W
  ctx.drawImage(img, 0, sy, W, h, x, dy, W, h)
  if (x > 0) ctx.drawImage(img, 0, sy, W, h, x - W, dy, W, h)
}

// the same with its colours split: the red to one side, the green and blue to the other
function splitRow(ctx: CanvasRenderingContext2D, L: Layers, sy: number, h: number, dy: number, dx: number, split: number) {
  if (split < 0.5) return row(ctx, L.photo, sy, h, dy, dx)
  row(ctx, L.red, sy, h, dy, dx - split)
  ctx.globalCompositeOperation = 'lighter'
  row(ctx, L.cyan, sy, h, dy, dx + split)
  ctx.globalCompositeOperation = 'source-over'
}

// One ghost on the ghosts' canvas. Its prominence p (1 as designed) scales how many pieces, how
// big, how far out of place and how strong; up to as designed, also how opaque.
function paint(ctx: CanvasRenderingContext2D, L: Layers, g: Ghost, t: number) {
  const { W, H } = L
  const { p } = g
  const x = (t - g.start) / g.ms // how far through it
  const pr = random(mix(g.seed, DISPLAY_SEED)) // this display's pieces: the same every frame
  const jr = random(mix(g.seed ^ DISPLAY_SEED, Math.floor(t / JITTER_MS))) // its jitter
  const opaque = Math.min(1, p)
  ctx.globalAlpha = opaque
  switch (g.kind) {
    // analog
    case 'tear': {
      const n = 1 + Math.floor(pr() * (2 + 3 * g.weak) * p)
      for (let i = 0; i < n; i++) {
        const h = clamp(Math.round((0.004 + pr() ** 2 * 0.09) * H * p), 1, H - 1)
        const dy = Math.floor(pr() * (H - h))
        const sy = pr() < 0.5 ? dy : Math.floor(pr() * (H - h)) // its own lines, or some from elsewhere
        const dx = ((pr() * 2 - 1) * 0.25 * W + (jr() * 2 - 1) * 0.04 * W) * p
        ctx.globalAlpha = (jr() < 0.15 ? 0.35 : 0.95) * opaque
        splitRow(ctx, L, sy, h, dy, dx, (1 + jr() * 4) * (0.3 + g.weak) * p)
      }
      break
    }
    case 'echo': {
      const y = Math.floor(pr() * H * 0.6)
      const h = Math.min(H - y, Math.floor(H * (0.2 + pr() * 0.4) * (0.5 + p / 2)))
      const dx = W * (0.02 + pr() * 0.06) * p
      const a = Math.min(0.9, (0.16 + 0.24 * g.weak) * p) * Math.sin(Math.PI * x) * (jr() < 0.2 ? 0.5 : 1)
      ctx.globalAlpha = a
      row(ctx, L.photo, y, h, y, dx)
      ctx.globalAlpha = a * 0.45 // and a fainter one further on
      row(ctx, L.photo, y, h, y, dx * 2.1)
      break
    }
    case 'roll': {
      const off = Math.floor(((x * (1 + pr() * 2)) % 1) * H)
      const dx = Math.round((jr() * 2 - 1) * 0.01 * W * p)
      const a = Math.min(0.9, (0.2 + 0.2 * g.weak) * p) * Math.min(1, x * 6, (1 - x) * 6)
      ctx.globalAlpha = a
      ctx.drawImage(L.photo, dx, off)
      ctx.drawImage(L.photo, dx, off - H)
      // the black bar between one frame and the next
      const bar = Math.max(1, Math.round(H * 0.05 * Math.max(0.5, p)))
      ctx.globalAlpha = Math.min(1, a * 2.5)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, off - bar, W, bar)
      break
    }
    // digital
    case 'blocks': {
      const B = BLOCK
      const cols = Math.ceil(W / B)
      const rows = Math.ceil(H / B)
      const runs = 1 + Math.floor(pr() * (1 + 2 * g.weak) * p)
      for (let r = 0; r < runs; r++) {
        let at = Math.floor(pr() * cols * rows)
        const n = Math.round((8 + pr() * 40) * (0.5 + g.weak) * p)
        const shown = Math.ceil(n * Math.min(1, x / 0.25)) // the run comes in block by block
        // where its blocks come from: their own place, or somewhere else
        const ox = pr() < 0.35 ? 0 : Math.round((pr() * 2 - 1) * 12 * p) * B
        const oy = pr() < 0.35 ? 0 : Math.round((pr() * 2 - 1) * 6 * p) * B
        for (let i = 0; i < n; i++, at++) {
          const v = pr()
          if (i >= shown) continue
          const bx = (at % cols) * B
          const by = (Math.floor(at / cols) % rows) * B
          const sx = clamp(bx + ox, 0, W - B)
          const sy = clamp(by + oy, 0, H - B)
          if (v < 0.7) ctx.drawImage(L.photo, sx, sy, B, B, bx, by, B, B)
          else if (v < 0.8) ctx.drawImage(L.red, sx, sy, B, B, bx, by, B, B) // a channel lost
          else if (v < 0.88) ctx.drawImage(L.cyan, sx, sy, B, B, bx, by, B, B)
          else ctx.drawImage(L.photo, sx + B / 2, sy + B / 2, 1, 1, bx, by, B, B) // only its average: flat
        }
      }
      break
    }
    case 'smear': {
      const B = BLOCK
      const n = 1 + Math.floor(pr() * (1 + 2 * g.weak) * p)
      for (let i = 0; i < n; i++) {
        const y = Math.floor(pr() * Math.max(1, Math.floor(H / B) - 1)) * B
        const x0 = Math.floor(pr() * Math.floor(W / B)) * B
        const w = Math.max(B, Math.min(W - x0, Math.round(((0.1 + pr() * 0.5) * W * p) / B) * B))
        const h = Math.round((2 + pr() * 10 * (0.5 + g.weak)) * B * p * Math.min(1, 0.1 + x / 0.3))
        ctx.drawImage(L.photo, x0, y, w, B, x0, y, w, B) // the last good row of blocks
        ctx.drawImage(L.photo, x0, y + B - 1, w, 1, x0, y + B, w, h) // and its last line, dragged down
      }
      break
    }
    case 'mosaic': {
      const B = BLOCK * 2
      const grow = 0.6 + 0.4 * p
      const cw = clamp(Math.floor((W * (0.2 + pr() * 0.35) * grow) / B), 1, Math.floor(W / B))
      const ch = clamp(Math.floor((H * (0.2 + pr() * 0.4) * grow) / B), 1, Math.floor(H / B))
      const c0 = Math.floor(pr() * Math.max(0, Math.floor(W / B) - cw))
      const r0 = Math.floor(pr() * Math.max(0, Math.floor(H / B) - ch))
      const density = Math.min(0.9, (0.25 + 0.2 * g.weak) * p) * Math.min(1, x * 5, (1 - x) * 5)
      ctx.globalAlpha = 0.9 * opaque
      for (let r = 0; r < ch; r++) {
        for (let c = 0; c < cw; c++) {
          const v = pr()
          if (v >= density || jr() < 0.06) continue
          const bx = (c0 + c) * B
          const by = (r0 + r) * B
          ctx.drawImage(L.photo, bx, by, B, B, bx, by, B, B) // the photo, where it is
        }
      }
      break
    }
  }
  ctx.globalAlpha = 1
}

// the photo at the size this display already decodes it for its other sky (the look-up moment,
// or the globe's texture, as GlobeView loads it): no second decode
const photoWidth = () => (VIEW === 'globe' ? (CAMERA === 'follow' ? 2560 : 1920) : cenitWidth())

export function Ghosts() {
  const l = useLink()
  const now = useTicker(1000)
  const slot = activeSlot(l.state, now)
  const slotId = slot?.id ?? null
  // the pass's photo; for a test on a pass without one, the one it would have had at 100%
  const sky = slot ? skyFor(slot.id, l.state?.sky, l.state?.config.sky) : null
  const testing = l.ghostTests.some((test) => test.at > now - 20_000)
  const file = sky ?? (testing ? skyFor(slotId ?? 0, l.state?.sky, 100) : null)
  const image = useSky(file, photoWidth())
  const real = !!sky && file === sky // the pass's own: its ghosts come on their own
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d')!
    const scan = ctx.createPattern(scanTile(), 'repeat')!
    const size = (): [number, number] => [
      Math.max(1, Math.round(canvas.clientWidth * SCALE)),
      Math.max(1, Math.round(canvas.clientHeight * SCALE)),
    ]
    // made now, not at the first ghost: it takes a moment
    let layers: Layers | null = canvas.clientWidth > 0 ? layersFor(image, ...size()) : null
    let shown = false
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const t = link.now()
      const s = liveSlot(slotId)
      // none of their own on a live pass (the real receiver): the real signal breaks up on its own
      const on = real && s && !s.pass.live && link.state?.config.ghostsOn !== false && t >= s.aos && t < s.los + MAX_MS
      // one at a time: a test showing hides the pass's own
      const tests = testsAt(t, s)
      const ghosts = tests.length ? tests : on ? ghostsAt(s, t) : []
      if (!ghosts.length) {
        if (shown) canvas.style.visibility = 'hidden'
        shown = false
        return
      }
      const [W, H] = size()
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      if (!layers || layers.W !== W || layers.H !== H) layers = layersFor(image, W, H)
      ctx.clearRect(0, 0, W, H)
      for (const g of ghosts) paint(ctx, layers, g, t)
      // the analog ones' scanlines
      if (ghosts.some((g) => GHOST_FAMILY[g.kind] === 'NOAA')) {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = scan
        ctx.fillRect(0, 0, W, H)
        ctx.globalCompositeOperation = 'source-over'
      }
      if (!shown) canvas.style.visibility = 'visible'
      shown = true
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      canvas.style.visibility = 'hidden'
    }
  }, [slotId, image, real])

  return <canvas ref={canvasRef} className="ghosts" style={{ visibility: 'hidden' }} />
}
