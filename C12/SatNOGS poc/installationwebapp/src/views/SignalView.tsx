import { useEffect, useMemo, useRef, useState } from 'react'
import { glitch } from '../art/burn.ts'
import type { PathWord } from '../art/field.ts'
import { random, textSeed } from '../art/phrases.ts'
import { skyFor } from '../art/sky.ts'
import { useSky } from '../art/skyImages.ts'
import { usePathWords } from '../art/usePathWords.ts'
import { useCanvasLoop } from '../canvas.ts'
import { COLORS, FONT } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { fmt, num, strings, useStrings } from '../i18n.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import type { Slot } from '../shared/protocol.ts'
import { loadSpectrogram, type Spectrogram } from '../spectrogram.ts'
import { SignalChart, SignalTiles, hasRealSignal, passSamples } from './LiveCharts.tsx'
import { activeSlot, geometryFor, phaseAt, satTimeAt } from '../timeline.ts'

const D2R = Math.PI / 180
const COLUMNS = 213 // 0-5 kHz at the spectrogram's resolution
const VISIBLE_ROWS = 25 * 60 // the last minute
const TICKS_HZ = [1000, 2000, 2400, 3000, 4000]

// spectrogram value -> dark blue, cyan, yellow, white
const LUT = Array.from({ length: 256 }, (_, v) => {
  const x = v / 255
  const c = (n: number) => 255 * Math.min(1, Math.max(0, n))
  return [c(x * 2.2 - 0.6), c(x * 1.6 - 0.15), c(0.25 + x * 1.4)] as [number, number, number]
})

// With a sky photo the noise is the photo: it lies behind the waterfall and shows through the
// noise, as much as the noise is bright, while the signal keeps its colours. Per spectrogram
// value, the colour and opacity of the waterfall's pixel over the photo, so that the two read
// signal x its colour + (1 - signal) x noise x photo.
const SIGNAL_FROM = 120 // where the signal starts taking over from the noise
const SIGNAL_FULL = 210
const NOISE_FULL = 130 // noise this bright lets all of the photo through
const OVER_SKY = LUT.map(([r, g, b], v): [number, number, number, number] => {
  const x = Math.min(1, Math.max(0, (v - SIGNAL_FROM) / (SIGNAL_FULL - SIGNAL_FROM)))
  const signal = x * x * (3 - 2 * x)
  const grain = Math.min(1, v / NOISE_FULL) ** 0.8
  const a = signal + (1 - signal) * (1 - grain)
  return a > 0 ? [(signal * r) / a, (signal * g) / a, (signal * b) / a, a * 255] : [0, 0, 0, 0]
})

// a photo filling w x h (cover), as a canvas
function coverCanvas(image: ImageBitmap, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const k = Math.max(w / image.width, h / image.height)
  canvas
    .getContext('2d')!
    .drawImage(image, (w - image.width * k) / 2, (h - image.height * k) / 2, image.width * k, image.height * k)
  return canvas
}

export const OPAQUE = LUT.map(([r, g, b]): [number, number, number, number] => [r, g, b, 255])

const noise = () => Math.floor(Math.random() ** 2 * 70)

// elevation of the satellite at t, if the slot is receiving
function receivingElevation(s: Slot | null, t: number): number | null {
  const config = link.state?.config
  if (!s || !config || phaseAt(s, t) !== 'pass') return null
  const g = geometryFor(s.pass, config)
  return g.look(satTimeAt(s, g, t)).elevation
}

// when the satellite reaches a phrase word: server time, ms
export const reachedAt = (s: Slot, word: PathWord) => s.aos + word.at * (s.los - s.aos)

export interface Mark extends PathWord {
  cols: number
  rows: number
  ink: Uint8Array // cols × rows, 0..255
}

// A phrase word as a grid of spectrogram cells (columns = frequency, rows = time). Drawn at its
// on-screen proportions and then squeezed into the grid, so it reads right once the waterfall
// is stretched to the screen: about a third of its height, up to 80% of its width. (The live
// waterfall, LiveCharts.tsx, has a grid of its own.)
export function wordMark(word: PathWord, screenW: number, screenH: number, columns = COLUMNS, visibleRows = VISIBLE_ROWS): Mark {
  const text = word.text.toUpperCase()
  const boxH = screenH * 0.32
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = `600 100px ${FONT}`
  const fontPx = Math.min(boxH * 0.8, (screenW * 0.76 * 100) / probe.measureText(text).width)
  const font = `600 ${fontPx}px ${FONT}`
  probe.font = font
  const boxW = Math.min(screenW * 0.8, probe.measureText(text).width + fontPx * 0.3)

  const big = document.createElement('canvas')
  big.width = Math.max(1, Math.ceil(boxW))
  big.height = Math.max(1, Math.ceil(boxH))
  const bc = big.getContext('2d')!
  bc.font = font
  bc.textAlign = 'center'
  bc.textBaseline = 'middle'
  bc.fillStyle = '#fff'
  bc.fillText(text, big.width / 2, big.height / 2)
  // the same signal glitch as the words in the image
  const glitched = document.createElement('canvas')
  glitched.width = big.width
  glitched.height = big.height
  glitch(glitched.getContext('2d')!, big, 0, big.height, fontPx, random(textSeed(text)))

  const cols = Math.max(1, Math.round((boxW / screenW) * columns))
  const rows = Math.max(1, Math.round((boxH / screenH) * visibleRows))
  const grid = document.createElement('canvas')
  grid.width = cols
  grid.height = rows
  const gc = grid.getContext('2d')!
  gc.drawImage(glitched, 0, 0, cols, rows)
  const px = gc.getImageData(0, 0, cols, rows).data
  const ink = new Uint8Array(cols * rows)
  for (let i = 0; i < ink.length; i++) ink[i] = px[i * 4 + 3]
  return { ...word, cols, rows, ink }
}

// APT: the real recording's spectrum, newest row on top, scrolling down; noise outside the pass.
// Each phrase word gets written into it from the moment the satellite reaches it, bottom of the
// letters first, so it rises in at the top and scrolls down with the signal. On a pass with a
// sky photo, the photo shows through the noise (OVER_SKY).
function Waterfall(props: { slotId: number; url: string; words: PathWord[] | null; sky: ImageBitmap | null }) {
  const { slotId, url, words, sky } = props
  const text = useStrings().signal
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const skyRef = useRef<HTMLCanvasElement>(null)
  const specRef = useRef<Spectrogram | null>(null)
  const [status, setStatus] = useState<'decoding' | 'ready' | 'error'>('decoding')

  useEffect(() => {
    let alive = true
    specRef.current = null
    setStatus('decoding')
    loadSpectrogram(url).then(
      (s) => {
        if (!alive) return
        specRef.current = s
        setStatus('ready')
      },
      () => alive && setStatus('error'),
    )
    return () => {
      alive = false
    }
  }, [url])

  // the photo behind, at the waterfall's size on screen
  useEffect(() => {
    const back = skyRef.current
    if (!back || !sky) return
    const paint = () => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(back.clientWidth * dpr))
      const h = Math.max(1, Math.round(back.clientHeight * dpr))
      back.width = w
      back.height = h
      back.getContext('2d')!.drawImage(coverCanvas(sky, w, h), 0, 0)
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(back)
    return () => observer.disconnect()
  }, [sky])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const overSky = !!sky
    const marks = (words ?? []).map((w) => wordMark(w, canvas.clientWidth || 900, canvas.clientHeight || 600))
    canvas.width = COLUMNS
    canvas.height = VISIBLE_ROWS
    let placed: { r0: number; x0: number; m: Mark }[] = []
    let last: number | null = null
    let raf = 0

    // spectrogram row `i` (row 0 = AOS) into image row y
    const fill = (img: ImageData, y: number, i: number) => {
      const s = specRef.current
      const live = !!s && i >= 0 && i < s.count
      const inked = placed.filter((p) => i >= p.r0 && i < p.r0 + p.m.rows)
      for (let x = 0; x < COLUMNS; x++) {
        let v = live ? s.rows[i * s.bins + Math.min(s.bins - 1, Math.floor((x * s.bins) / COLUMNS))] : noise()
        for (const p of inked) {
          const col = x - p.x0
          if (col < 0 || col >= p.m.cols) continue
          const ink = p.m.ink[(p.r0 + p.m.rows - 1 - i) * p.m.cols + col] // its top row is the newest
          if (ink) v = Math.max(v, Math.min(255, Math.round((ink * 225) / 255 + Math.random() * 30)))
        }
        const o = (y * COLUMNS + x) * 4
        const [r, g, b, a] = (overSky ? OVER_SKY : OPAQUE)[v]
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = a
      }
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = liveSlot(slotId)
      const speed = link.state?.config.speed ?? 1
      const rps = specRef.current?.rowsPerSecond ?? 25
      const seconds = s ? ((link.now() - s.aos) / 1000) * speed : 1e9
      const r = Math.floor(seconds * rps)
      // the row each word starts at: the moment the satellite reaches it (follows speed changes)
      placed = s
        ? marks.map((m) => ({
            r0: Math.floor(((reachedAt(s, m) - s.aos) / 1000) * speed * rps),
            x0: Math.round(((COLUMNS - m.cols) / 2) * (1 + m.across)),
            m,
          }))
        : []
      if (last === null || r < last || r - last >= VISIBLE_ROWS) {
        const img = ctx.createImageData(COLUMNS, VISIBLE_ROWS)
        for (let y = 0; y < VISIBLE_ROWS; y++) fill(img, y, r - y)
        ctx.putImageData(img, 0, 0)
      } else if (r > last) {
        const n = r - last
        // copy, not over: the pixels let the photo through, they'd add up
        ctx.globalCompositeOperation = 'copy'
        ctx.drawImage(canvas, 0, n)
        ctx.globalCompositeOperation = 'source-over'
        const img = ctx.createImageData(COLUMNS, n)
        for (let y = 0; y < n; y++) fill(img, y, r - y)
        ctx.putImageData(img, 0, 0)
      }
      last = r
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [slotId, status, words, sky])

  return (
    <div className="waterfall">
      {sky && <canvas ref={skyRef} className="wf-sky" />}
      <canvas ref={canvasRef} className="wf-main" />
      {TICKS_HZ.map((hz) => (
        <span key={hz} className={hz === 2400 ? 'wf-tick carrier' : 'wf-tick'} style={{ left: `${(hz / 5000) * 100}%` }}>
          {hz === 2400 ? text.carrier : `${hz / 1000} kHz`}
        </span>
      ))}
      <span className="signal-note">
        {status === 'decoding' ? text.decoding : status === 'error' ? text.unreadable : text.spectrum}
      </span>
    </div>
  )
}

// How the constellation spells a word (real time, ms). The words are known from the start of
// the pass, so the dots start gathering ahead and are at their most defined right when the
// satellite reaches the word; then it holds and scatters back to the signal.
const SPELL_LEAD_MS = 6000 // at most: less when the previous word ended just before
const SPELL_HOLD_MS = 2500
const SPELL_OUT_MS = 900

interface Spell {
  points: Float32Array // x, y pairs over the word's letters, 0..1
  aspect: number // width / height
}

// how far a word gets defined at most (0..1): 80 to 95%, different for each word but the same
// on every display, so it gets readable without ever being sharp
const peakDefinition = (text: string) => 0.9 + random(textSeed(text))() * 0.05

// the letters of a word as points
function wordPoints(text: string): { points: Float32Array; aspect: number } {
  const size = 120
  const font = `600 ${size}px ${FONT}`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.font = font
  canvas.width = Math.ceil(ctx.measureText(text).width + size * 0.2)
  canvas.height = Math.ceil(size * 1.2)
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const points: number[] = []
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      if (px[(y * canvas.width + x) * 4 + 3] > 128) points.push(x / canvas.width, y / canvas.height)
    }
  }
  return { points: Float32Array.from(points), aspect: canvas.width / canvas.height }
}

// METEOR LRPT is digital: no audio to show, so a QPSK constellation that locks while the
// satellite is up and tightens with elevation (simulated). When the satellite reaches a phrase
// word, the dots gather into its letters for a few seconds, then go back to the signal.
function Constellation(props: { slotId: number | null; words: PathWord[] | null; sky: ImageBitmap | null }) {
  const { slotId, words, sky } = props
  const text = useStrings().signal
  // On a pass with a sky photo the locked dots take its colours, each the photo's colour where it
  // lands: drawn white on a layer of their own, which then takes the photo where it has a dot.
  const colors = useRef<{ sky: ImageBitmap; canvas: HTMLCanvasElement } | null>(null)
  const dotsRef = useRef<HTMLCanvasElement | null>(null)
  const shapes = useMemo(
    () => (words ?? []).map((w) => ({ word: w, peak: peakDefinition(w.text), ...wordPoints(w.text.toUpperCase()) })),
    [words],
  )
  const ref = useCanvasLoop(
    (ctx, w, h, dpr) => {
      ctx.fillStyle = 'rgba(5, 7, 12, 0.2)'
      ctx.fillRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      const scale = Math.min(w, h) * 0.3
      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.moveTo(cx - scale * 1.8, cy)
      ctx.lineTo(cx + scale * 1.8, cy)
      ctx.moveTo(cx, cy - scale * 1.8)
      ctx.lineTo(cx, cy + scale * 1.8)
      ctx.stroke()
      const s = liveSlot(slotId)
      const t = link.now()
      const el = receivingElevation(s, t)
      const locked = el != null && el > 0
      const sigma = locked ? 0.05 + 0.35 * (1 - Math.sin(el * D2R)) : 0.7
      const size = 2 * dpr

      // the word being spelled: envelope 0..1 (1: every dot on the word, the signal's four
      // clusters gone), definition 0..its peak (how sharp it gets, never quite 1)
      let spell: Spell | null = null
      let envelope = 0
      let definition = 0
      if (s) {
        let previousEnd = s.aos
        for (const shape of shapes) {
          const reach = reachedAt(s, shape.word)
          const lead = Math.max(0, reach - Math.max(reach - SPELL_LEAD_MS, previousEnd))
          previousEnd = reach + SPELL_HOLD_MS + SPELL_OUT_MS
          const dt = t - reach
          if (dt < -lead || dt >= SPELL_HOLD_MS + SPELL_OUT_MS) continue
          spell = { points: shape.points, aspect: shape.aspect }
          if (dt < 0) envelope = ease(1 + dt / lead) // gathering
          else if (dt < SPELL_HOLD_MS) envelope = 1
          else envelope = (SPELL_HOLD_MS + SPELL_OUT_MS - dt) / SPELL_OUT_MS // scattering
          definition = envelope * shape.peak
        }
      }
      const share = envelope // of the dots on the word; the rest stay the signal

      // the pen: the screen, or (locked, with a sky photo) the dots' own layer
      let pen = ctx
      let photo: HTMLCanvasElement | null = null
      if (locked && sky) {
        photo = colors.current?.sky === sky ? colors.current.canvas : null
        if (!photo || photo.width !== w || photo.height !== h) {
          photo = coverCanvas(sky, w, h)
          colors.current = { sky, canvas: photo }
        }
        const layer = (dotsRef.current ??= document.createElement('canvas'))
        if (layer.width !== w || layer.height !== h) {
          layer.width = w
          layer.height = h
        }
        pen = layer.getContext('2d')!
        pen.clearRect(0, 0, w, h)
        pen.fillStyle = '#fff'
      } else {
        ctx.fillStyle = locked ? COLORS.rx : COLORS.dim // the word's dots too: same colour
      }
      const count = Math.round(160 + 290 * envelope)
      const letters: number[] = [] // dots that go on the word: index into its points
      for (let i = 0; i < count; i++) {
        if (spell && spell.points.length && Math.random() < share) {
          letters.push(Math.floor(Math.random() * (spell.points.length / 2)) * 2)
          continue
        }
        const sx = locked ? (Math.random() < 0.5 ? -1 : 1) / Math.SQRT2 : 0
        const sy = locked ? (Math.random() < 0.5 ? -1 : 1) / Math.SQRT2 : 0
        pen.fillRect(cx + (sx + gauss() * sigma) * scale, cy - (sy + gauss() * sigma) * scale, size, size)
      }
      if (spell && letters.length) {
        const wordW = Math.min(w * 0.85, h * 0.55 * spell.aspect)
        const wordH = wordW / spell.aspect
        const jitter = scale * (0.04 + 0.4 * (1 - definition)) + dpr // the less defined, the looser
        for (const k of letters) {
          const x = cx + (spell.points[k] - 0.5) * wordW + gauss() * jitter
          const y = cy + (spell.points[k + 1] - 0.5) * wordH + gauss() * jitter
          pen.fillRect(x, y, size, size)
        }
      }
      if (photo && pen !== ctx) {
        pen.globalCompositeOperation = 'source-in' // the dots, in the photo's colours
        pen.drawImage(photo, 0, 0)
        pen.globalCompositeOperation = 'source-over'
        ctx.drawImage(pen.canvas, 0, 0)
      }
    },
    [slotId, shapes, sky],
  )
  return (
    <div className="waterfall">
      <canvas ref={ref} className="fill" />
      <span className="signal-note">{text.constellation}</span>
    </div>
  )
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
}

export function SignalView() {
  const l = useLink()
  const text = useStrings().signal
  const now = useTicker(100)
  const slot = activeSlot(l.state, now)
  // the words become pixels: only once their font is loaded, or they'd keep the fallback one
  const [fontReady, setFontReady] = useState(false)
  useEffect(() => {
    document.fonts
      .load(`600 100px ${FONT}`)
      .catch(() => {})
      .finally(() => setFontReady(true))
  }, [])
  const pathWords = usePathWords(slot)
  const words = fontReady ? pathWords : null
  const el = receivingElevation(slot, now)
  // a real pass (the receiver's, live or imported and replayed): its SNR; a made-up one: as the
  // satellite climbs
  const live = !!slot && hasRealSignal(slot)
  const latest = slot && live && !slot.pass.live ? (passSamples(slot).at(-1) ?? null) : null
  const reading = slot?.pass.live
    ? l.live && now - l.live.t < 10_000
      ? { snr: l.live.snr, lock: !!l.live.deframer_lock }
      : null
    : latest
      ? { snr: latest.snr, lock: !!latest.lock }
      : null
  const snr = reading?.snr ?? null
  const level = live ? (snr != null ? Math.min(1, Math.max(0, snr / 12)) : 0) : el != null && el > 0 ? Math.sin(el * D2R) : 0
  // the pass's sky photo: behind the waterfall's noise (NOAA), the dots' colours (METEOR)
  const skyFile = slot ? skyFor(slot.id, l.state?.sky, l.state?.config.sky) : null
  const apt = !!slot?.pass.audio
  const sky = useSky(skyFile, apt ? 1920 : 1280)

  return (
    <Display title="signal">
      <div className="signal">
        {live && slot ? (
          <>
            <SignalTiles slot={slot} />
            <div className="live-chart">
              <SignalChart slotId={slot.id} />
            </div>
          </>
        ) : slot?.pass.audio ? (
          <Waterfall key={slot.id} slotId={slot.id} url={slot.pass.audio} words={words} sky={sky} />
        ) : (
          <Constellation slotId={slot?.id ?? null} words={words} sky={sky} />
        )}
        <div className="meter">
          <span className="dim">{text.signal}</span>
          <div className="meter-bar">
            <div style={{ width: `${level * 100}%` }} />
          </div>
          <span>
            {live
              ? snr != null
                ? `SNR ${num(snr, 1)} dB${reading?.lock ? '' : ' · ' + strings().live.noLock}`
                : text.noSignal
              : el != null && el > 0
                ? fmt(text.elevation, { el: num(el, 1) })
                : text.noSignal}
          </span>
        </div>
      </div>
    </Display>
  )
}
