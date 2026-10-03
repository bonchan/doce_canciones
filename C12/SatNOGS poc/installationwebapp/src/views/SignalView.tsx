import { useEffect, useRef, useState } from 'react'
import { useCanvasLoop } from '../canvas.ts'
import { COLORS } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { fmt, num, useStrings } from '../i18n.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import type { Slot } from '../shared/protocol.ts'
import { loadSpectrogram, type Spectrogram } from '../spectrogram.ts'
import { activeSlot, geometryFor, phaseAt, satTimeAt } from '../timeline.ts'

const D2R = Math.PI / 180
const COLUMNS = 213 // 0-5 kHz at the spectrogram's resolution
const VISIBLE_ROWS = 25 * 60 // the last minute
const TICKS_HZ = [1000, 2000, 2400, 3000, 4000]

// spectrogram value -> dark blue, cyan, yellow, white
const LUT = Array.from({ length: 256 }, (_, v) => {
  const x = v / 255
  const c = (n: number) => 255 * Math.min(1, Math.max(0, n))
  return [c(x * 2.2 - 0.6), c(x * 1.6 - 0.15), c(0.25 + x * 1.4)]
})

const noise = () => Math.floor(Math.random() ** 2 * 70)

// elevation of the satellite at t, if the slot is receiving
function receivingElevation(s: Slot | null, t: number): number | null {
  const config = link.state?.config
  if (!s || !config || phaseAt(s, t) !== 'pass') return null
  const g = geometryFor(s.pass, config)
  return g.look(satTimeAt(s, g, t)).elevation
}

// APT: the real recording's spectrum, newest row on top, scrolling down; noise outside the pass
function Waterfall({ slotId, url }: { slotId: number; url: string }) {
  const text = useStrings().signal
  const canvasRef = useRef<HTMLCanvasElement>(null)
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

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    canvas.width = COLUMNS
    canvas.height = VISIBLE_ROWS
    let last: number | null = null
    let raf = 0

    // spectrogram row `i` (row 0 = AOS) into image row y
    const fill = (img: ImageData, y: number, i: number) => {
      const s = specRef.current
      const live = !!s && i >= 0 && i < s.count
      for (let x = 0; x < COLUMNS; x++) {
        const v = live ? s.rows[i * s.bins + Math.min(s.bins - 1, Math.floor((x * s.bins) / COLUMNS))] : noise()
        const o = (y * COLUMNS + x) * 4
        const [r, g, b] = LUT[v]
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = 255
      }
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = liveSlot(slotId)
      const speed = link.state?.config.speed ?? 1
      const seconds = s ? ((link.now() - s.aos) / 1000) * speed : 1e9
      const r = Math.floor(seconds * (specRef.current?.rowsPerSecond ?? 25))
      if (last === null || r < last || r - last >= VISIBLE_ROWS) {
        const img = ctx.createImageData(COLUMNS, VISIBLE_ROWS)
        for (let y = 0; y < VISIBLE_ROWS; y++) fill(img, y, r - y)
        ctx.putImageData(img, 0, 0)
      } else if (r > last) {
        const n = r - last
        ctx.drawImage(canvas, 0, n)
        const img = ctx.createImageData(COLUMNS, n)
        for (let y = 0; y < n; y++) fill(img, y, r - y)
        ctx.putImageData(img, 0, 0)
      }
      last = r
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [slotId, status])

  return (
    <div className="waterfall">
      <canvas ref={canvasRef} />
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

// METEOR LRPT is digital: no audio to show, so a QPSK constellation that locks while the
// satellite is up and tightens with elevation (simulated)
function Constellation({ slotId }: { slotId: number | null }) {
  const text = useStrings().signal
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
      const el = receivingElevation(liveSlot(slotId), link.now())
      const locked = el != null && el > 0
      const sigma = locked ? 0.05 + 0.35 * (1 - Math.sin(el * D2R)) : 0.7
      ctx.fillStyle = locked ? COLORS.rx : COLORS.dim
      const size = 2 * dpr
      for (let i = 0; i < 160; i++) {
        const sx = locked ? (Math.random() < 0.5 ? -1 : 1) / Math.SQRT2 : 0
        const sy = locked ? (Math.random() < 0.5 ? -1 : 1) / Math.SQRT2 : 0
        ctx.fillRect(cx + (sx + gauss() * sigma) * scale, cy - (sy + gauss() * sigma) * scale, size, size)
      }
    },
    [slotId],
  )
  return (
    <div className="waterfall">
      <canvas ref={ref} className="fill" />
      <span className="signal-note">{text.constellation}</span>
    </div>
  )
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
}

export function SignalView() {
  const l = useLink()
  const text = useStrings().signal
  const now = useTicker(100)
  const slot = activeSlot(l.state, now)
  const el = receivingElevation(slot, now)
  const level = el != null && el > 0 ? Math.sin(el * D2R) : 0

  return (
    <Display title="signal">
      <div className="signal">
        {slot?.pass.audio ? (
          <Waterfall key={slot.id} slotId={slot.id} url={slot.pass.audio} />
        ) : (
          <Constellation slotId={slot?.id ?? null} />
        )}
        <div className="meter">
          <span className="dim">{text.signal}</span>
          <div className="meter-bar">
            <div style={{ width: `${level * 100}%` }} />
          </div>
          <span>{el != null && el > 0 ? fmt(text.elevation, { el: num(el, 1) }) : text.noSignal}</span>
        </div>
      </div>
    </Display>
  )
}
