// What the real receiver (raspberry_sat) shows of a live pass, drawn like its own Live page: the
// signal over the pass (SNR, the elevation behind it, a strip green while frames sync, red while
// not), the spectrum, and the reception screen's waterfall of that spectrum with the phrase words
// written into it as the satellite reaches them.
import { useEffect, useRef } from 'react'
import type { PathWord } from '../art/field.ts'
import { useCanvasLoop } from '../canvas.ts'
import { COLORS, FONT } from '../colors.ts'
import { fmt, num, strings, useStrings } from '../i18n.ts'
import { link, liveSlot } from '../link.ts'
import type { LiveSample, Slot } from '../shared/protocol.ts'
import { OPAQUE, reachedAt, wordMark, type Mark } from './SignalView.tsx'

export const SYNC = '#3ecf8e' // frames sync (raspberry_sat's colours)
export const NO_SYNC = '#e5484d'

// an imported real pass's signal.json, once fetched (null meanwhile)
const signals = new Map<string, LiveSample[] | null>()

function realSignal(url: string): LiveSample[] | null {
  if (!signals.has(url)) {
    signals.set(url, null)
    if (signals.size > 20) signals.delete(signals.keys().next().value!)
    fetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => signals.set(url, Array.isArray(d) ? d : []))
      .catch(() => signals.set(url, []))
  }
  return signals.get(url) ?? null
}

// a real pass: on air now (live) or replayed from the library with its signal
export const hasRealSignal = (s: Slot) => !!s.pass.live || !!s.pass.signal

// The pass's samples: a live pass's as they come (a display that joined late has them all from
// the server); an imported one's from its recording to now, its times moved onto the replay (AOS
// to LOS of the recording onto those of the slot, which runs at the installation's speed).
export function passSamples(s: Slot): LiveSample[] {
  if (s.pass.live) return link.liveSamples.filter((x) => x.t >= s.aos - 60_000 && x.t <= s.end)
  if (!s.pass.signal) return []
  const raw = realSignal(s.pass.signal)
  if (!raw?.length) return []
  const from = Date.parse(s.pass.start)
  const to = s.pass.end ? Date.parse(s.pass.end) : raw[raw.length - 1].t
  const k = (s.los - s.aos) / Math.max(1, to - from)
  const now = link.now()
  const out: LiveSample[] = []
  for (const x of raw) {
    const t = s.aos + (x.t - from) * k
    if (t > now) break
    out.push({ ...x, t })
  }
  return out
}

// the latest spectrum, if it's fresh
const freshSpectrum = () => {
  const sp = link.spectrum
  return sp && Math.abs(link.now() - sp.t) < 5000 ? sp : null
}

// SNR over the pass, the elevation behind it, the sync strip under it, now as a line
export function SignalChart({ slotId }: { slotId: number | null }) {
  const ref = useCanvasLoop(
    (ctx, w, h, dpr) => {
      ctx.clearRect(0, 0, w, h)
      const text = strings().live
      const s = liveSlot(slotId)
      if (!s) return
      const samples = passSamples(s)
      const left = 52 * dpr
      const right = w - 16 * dpr
      const top = 30 * dpr
      const stripH = 14 * dpr
      const bottom = h - 34 * dpr - stripH
      const x = (t: number) => left + ((t - s.aos) / Math.max(1, s.los - s.aos)) * (right - left)
      const snrs = samples.flatMap((p) => (p.snr == null ? [] : [p.snr]))
      const ymax = Math.max(10, Math.ceil(Math.max(0, ...snrs) + 1))
      const ySnr = (v: number) => bottom - (Math.max(0, v) / ymax) * (bottom - top)
      const yEl = (v: number) => bottom - (Math.max(0, v) / 90) * (bottom - top)

      // grid and axes
      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = dpr
      ctx.font = `${12 * dpr}px ${FONT}`
      ctx.fillStyle = COLORS.dim
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const y = bottom - f * (bottom - top)
        ctx.beginPath()
        ctx.moveTo(left, y)
        ctx.lineTo(right, y)
        ctx.stroke()
        ctx.fillText(num(f * ymax), left - 8 * dpr, y)
      }
      ctx.textAlign = 'left'
      ctx.fillText(text.snrAxis, left, top - 16 * dpr)
      ctx.textAlign = 'right'
      ctx.fillText(text.elevationAxis, right, top - 16 * dpr)

      const line = (points: [number, number][], style: string, width: number) => {
        if (points.length < 2) return
        ctx.beginPath()
        ctx.moveTo(...points[0])
        for (const p of points.slice(1)) ctx.lineTo(...p)
        ctx.strokeStyle = style
        ctx.lineWidth = width * dpr
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
      line(samples.flatMap((p) => (p.el == null ? [] : [[x(p.t), yEl(p.el)] as [number, number]])), COLORS.sat, 1.5)
      line(samples.flatMap((p) => (p.snr == null ? [] : [[x(p.t), ySnr(p.snr)] as [number, number]])), COLORS.rx, 2.5)

      // the sync strip
      const stripY = bottom + 10 * dpr
      samples.forEach((p, i) => {
        if (p.lock === undefined) return
        const x0 = x(p.t)
        const x1 = x(samples[i + 1]?.t ?? p.t + 1000)
        ctx.fillStyle = p.lock ? SYNC : NO_SYNC
        ctx.fillRect(x0, stripY, Math.max(dpr, x1 - x0), stripH)
      })
      ctx.fillStyle = COLORS.dim
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(text.syncLegend, left, stripY + stripH + 6 * dpr)

      // now
      const t = link.now()
      if (t >= s.aos && t <= s.los) {
        ctx.strokeStyle = COLORS.text
        ctx.globalAlpha = 0.5
        ctx.lineWidth = dpr
        ctx.beginPath()
        ctx.moveTo(x(t), top)
        ctx.lineTo(x(t), stripY + stripH)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    },
    [slotId],
  )
  return <canvas ref={ref} className="fill" />
}

// The receiver's spectrum right now: the band across, the tuned frequency in the middle, with a
// slowly falling peak line
export function SpectrumPlot() {
  const peak = useRef<Float32Array | null>(null)
  const ref = useCanvasLoop((ctx, w, h, dpr) => {
    ctx.clearRect(0, 0, w, h)
    const text = strings().live
    const left = 16 * dpr
    const right = w - 16 * dpr
    const top = 28 * dpr
    const bottom = h - 26 * dpr
    ctx.strokeStyle = COLORS.line
    ctx.lineWidth = dpr
    for (const f of [0.25, 0.5, 0.75]) {
      const y = bottom - f * (bottom - top)
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo((left + right) / 2, top)
    ctx.lineTo((left + right) / 2, bottom)
    ctx.stroke()
    ctx.font = `${12 * dpr}px ${FONT}`
    ctx.fillStyle = COLORS.dim
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(text.spectrum, left, 14 * dpr)

    const sp = freshSpectrum()
    if (!sp) {
      ctx.textAlign = 'center'
      ctx.fillText(text.noSpectrum, w / 2, (top + bottom) / 2)
      peak.current = null
      return
    }
    const n = sp.bins.length
    const xAt = (i: number) => left + (i / Math.max(1, n - 1)) * (right - left)
    const yAt = (v: number) => bottom - (v / 255) * (bottom - top)
    if (!peak.current || peak.current.length !== n) peak.current = new Float32Array(n)
    const pk = peak.current
    for (let i = 0; i < n; i++) pk[i] = Math.max(sp.bins[i], pk[i] - 0.6) // falls back slowly

    // filled trace
    const fill = ctx.createLinearGradient(0, top, 0, bottom)
    fill.addColorStop(0, 'rgba(127, 212, 255, 0.45)')
    fill.addColorStop(1, 'rgba(127, 212, 255, 0.02)')
    ctx.beginPath()
    ctx.moveTo(left, bottom)
    for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(sp.bins[i]))
    ctx.lineTo(right, bottom)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.beginPath()
    for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, xAt(i), yAt(sp.bins[i]))
    ctx.strokeStyle = COLORS.sat
    ctx.lineWidth = 1.5 * dpr
    ctx.stroke()
    ctx.beginPath()
    for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, xAt(i), yAt(pk[i]))
    ctx.strokeStyle = 'rgba(255, 200, 87, 0.6)'
    ctx.lineWidth = dpr
    ctx.stroke()

    // the band
    ctx.fillStyle = COLORS.dim
    ctx.textBaseline = 'top'
    if (sp.frequency) {
      ctx.textAlign = 'center'
      ctx.fillText(`${num(sp.frequency / 1e6, 3)} MHz`, (left + right) / 2, bottom + 8 * dpr)
    }
    if (sp.samplerate) {
      const khz = sp.samplerate / 2000
      ctx.textAlign = 'left'
      ctx.fillText(`−${num(khz)} kHz`, left, bottom + 8 * dpr)
      ctx.textAlign = 'right'
      ctx.fillText(`+${num(khz)} kHz`, right, bottom + 8 * dpr)
    }
  }, [])
  return <canvas ref={ref} className="fill" />
}

// The reception screen of a live pass: the image only exists once it's decoded, after LOS, so
// meanwhile the receiver's spectrum as a waterfall, newest on top, scrolling down, a row every
// quarter second; each phrase word written into it from the moment the satellite reaches it,
// bottom of the letters first, so it rises in at the top and scrolls down with the signal.
const LIVE_COLUMNS = 256
const ROW_MS = 250
const LIVE_ROWS = 240 // the last minute

const dark = () => Math.floor(Math.random() ** 2 * 50)

export function LiveWaterfall({ slotId, words }: { slotId: number; words: PathWord[] | null }) {
  const text = useStrings().live
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const marks: Mark[] = (words ?? []).map((w) =>
      wordMark(w, canvas.clientWidth || 900, canvas.clientHeight || 600, LIVE_COLUMNS, LIVE_ROWS),
    )
    canvas.width = LIVE_COLUMNS
    canvas.height = LIVE_ROWS
    const rows = new Map<number, Uint8Array>() // row (from AOS) -> the spectrum then
    let lastSpectrum = 0
    let last: number | null = null
    let raf = 0

    // a spectrum row: the one that arrived then, or held a moment from the one before
    const spectrumRow = (i: number) => {
      for (let k = 0; k < 6; k++) {
        const r = rows.get(i - k)
        if (r) return r
      }
      return null
    }

    const fill = (img: ImageData, y: number, i: number, s: Slot) => {
      const row = spectrumRow(i)
      const inked = marks.flatMap((m) => {
        const r0 = Math.floor((reachedAt(s, m) - s.aos) / ROW_MS)
        return i >= r0 && i < r0 + m.rows ? [{ m, r0, x0: Math.round(((LIVE_COLUMNS - m.cols) / 2) * (1 + m.across)) }] : []
      })
      for (let x = 0; x < LIVE_COLUMNS; x++) {
        let v = row ? row[Math.min(row.length - 1, Math.floor((x * row.length) / LIVE_COLUMNS))] : dark()
        for (const p of inked) {
          const col = x - p.x0
          if (col < 0 || col >= p.m.cols) continue
          const ink = p.m.ink[(p.r0 + p.m.rows - 1 - i) * p.m.cols + col] // its top row is the newest
          if (ink) v = Math.max(v, Math.min(255, Math.round((ink * 225) / 255 + Math.random() * 30)))
        }
        const o = (y * LIVE_COLUMNS + x) * 4
        const [r, g, b] = OPAQUE[v]
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = 255
      }
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = liveSlot(slotId)
      if (!s) return
      const now = link.now()
      const r = Math.floor((now - s.aos) / ROW_MS)
      const sp = freshSpectrum()
      if (sp && sp.t !== lastSpectrum) {
        lastSpectrum = sp.t
        rows.set(r, sp.bins)
        for (const k of rows.keys()) if (k < r - LIVE_ROWS - 8) rows.delete(k)
      }
      if (last === null || r < last || r - last >= LIVE_ROWS) {
        const img = ctx.createImageData(LIVE_COLUMNS, LIVE_ROWS)
        for (let y = 0; y < LIVE_ROWS; y++) fill(img, y, r - y, s)
        ctx.putImageData(img, 0, 0)
      } else if (r > last) {
        const n = r - last
        ctx.drawImage(canvas, 0, n)
        const img = ctx.createImageData(LIVE_COLUMNS, n)
        for (let y = 0; y < n; y++) fill(img, y, r - y, s)
        ctx.putImageData(img, 0, 0)
      }
      last = r
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [slotId, words])

  const r = link.live
  const fresh = r && link.now() - r.t < 10_000
  return (
    <div className="waterfall live-waterfall">
      <canvas ref={canvasRef} className="wf-main" />
      <span className="signal-note">
        {text.receiving}
        {fresh && r.snr != null ? ` · ${fmt(text.snr, { snr: r.snr.toFixed(1) })}` : ''}
        {fresh ? ` · ${r.deframer_lock ? text.locked : text.noLock}` : ''}
        {fresh && r.bytes > 0 ? ` · ${fmt(text.data, { mb: (r.bytes / 1e6).toFixed(1) })}` : ''}
        {` · ${text.afterLos}`}
      </span>
    </div>
  )
}
