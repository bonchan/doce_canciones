import { useCanvasLoop } from '../canvas.ts'
import { COLORS, FONT } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { num, strings, useStrings } from '../i18n.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { downlinkMHz, dopplerHz, pathLossDb, rangeRate } from '../radio.ts'
import { activeSlot, geometryFor, phaseAt, recordingTime, satTimeAt, stationFor } from '../timeline.ts'

const D2R = Math.PI / 180

// Polar sky plot as seen from the station: center = overhead, edge = horizon, north up
function SkyPlot({ slotId }: { slotId: number | null }) {
  const ref = useCanvasLoop(
    (ctx, w, h, dpr) => {
      ctx.clearRect(0, 0, w, h)
      const text = strings().telemetry
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w, h) / 2 - 34 * dpr
      ctx.lineWidth = dpr
      ctx.strokeStyle = COLORS.line
      for (const el of [0, 30, 60]) {
        ctx.beginPath()
        ctx.arc(cx, cy, R * (1 - el / 90), 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.moveTo(cx - R, cy)
      ctx.lineTo(cx + R, cy)
      ctx.moveTo(cx, cy - R)
      ctx.lineTo(cx, cy + R)
      ctx.stroke()
      ctx.fillStyle = COLORS.dim
      ctx.font = `${13 * dpr}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const off = R + 18 * dpr
      ctx.fillText(text.north, cx, cy - off)
      ctx.fillText(text.south, cx, cy + off)
      ctx.fillText(text.east, cx + off, cy)
      ctx.fillText(text.west, cx - off, cy)
      for (const el of [30, 60]) ctx.fillText(`${el}°`, cx + 14 * dpr, cy - R * (1 - el / 90) + 9 * dpr)

      const s = liveSlot(slotId)
      const config = link.state?.config
      if (!s || !config) return
      const g = geometryFor(s.pass, config)
      const t = link.now()
      const ts = satTimeAt(s, g, t)
      const xy = (time: number): [number, number] => {
        const lk = g.look(time)
        const r = R * (1 - Math.max(0, lk.elevation) / 90)
        return [cx + r * Math.sin(lk.azimuth * D2R), cy - r * Math.cos(lk.azimuth * D2R)]
      }
      const track = (from: number, to: number, style: string, width: number) => {
        if (to <= from) return
        ctx.beginPath()
        ctx.moveTo(...xy(from))
        for (let time = from + 4; time < to; time += 4) ctx.lineTo(...xy(time))
        ctx.lineTo(...xy(to))
        ctx.strokeStyle = style
        ctx.lineWidth = width * dpr
        ctx.stroke()
      }
      track(g.tAos, g.tLos, 'rgba(127, 212, 255, 0.3)', 2)
      track(g.tAos, Math.min(Math.max(ts, g.tAos), g.tLos), COLORS.sat, 3)
      ctx.fillStyle = COLORS.dim
      ctx.fillText(text.aos, ...offsetLabel(xy(g.tAos), cx, cy, 22 * dpr))
      ctx.fillText(text.los, ...offsetLabel(xy(g.tLos), cx, cy, 22 * dpr))
      if (g.look(ts).elevation > 0) {
        const [x, y] = xy(ts)
        const rx = phaseAt(s, t) === 'pass'
        ctx.shadowColor = rx ? COLORS.rx : COLORS.sat
        ctx.shadowBlur = 16 * dpr
        ctx.fillStyle = rx ? COLORS.rx : COLORS.sat
        ctx.beginPath()
        ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    },
    [slotId],
  )
  return <canvas ref={ref} className="fill" />
}

// a label pushed outwards from the plot center
function offsetLabel([x, y]: [number, number], cx: number, cy: number, by: number): [number, number] {
  const d = Math.hypot(x - cx, y - cy) || 1
  return [x + ((x - cx) / d) * by, y + ((y - cy) / d) * by]
}

// Doppler shift over the pass, with the current point
function DopplerPlot({ slotId }: { slotId: number | null }) {
  const ref = useCanvasLoop(
    (ctx, w, h, dpr) => {
      ctx.clearRect(0, 0, w, h)
      const pad = 40 * dpr
      const maxHz = 4000
      const y = (hz: number) => h / 2 - (hz / maxHz) * (h / 2 - 16 * dpr)
      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.moveTo(pad, y(0))
      ctx.lineTo(w - 12 * dpr, y(0))
      ctx.stroke()
      ctx.fillStyle = COLORS.dim
      ctx.font = `${12 * dpr}px ${FONT}`
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText('+4k', pad - 6 * dpr, y(maxHz))
      ctx.fillText('0', pad - 6 * dpr, y(0))
      ctx.fillText('−4k', pad - 6 * dpr, y(-maxHz))
      ctx.textAlign = 'left'
      ctx.fillText(strings().telemetry.dopplerAxis, pad + 6 * dpr, 14 * dpr)

      const s = liveSlot(slotId)
      const config = link.state?.config
      if (!s || !config) return
      const g = geometryFor(s.pass, config)
      const mhz = downlinkMHz(s.pass.satellite)
      const x = (time: number) => pad + ((time - g.tAos) / (g.tLos - g.tAos)) * (w - pad - 12 * dpr)
      ctx.beginPath()
      for (let time = g.tAos; time <= g.tLos; time += 10) {
        const py = y(dopplerHz(mhz, rangeRate(g, time)))
        if (time === g.tAos) ctx.moveTo(x(time), py)
        else ctx.lineTo(x(time), py)
      }
      ctx.strokeStyle = COLORS.sat
      ctx.lineWidth = 2 * dpr
      ctx.stroke()
      const ts = satTimeAt(s, g, link.now())
      if (ts >= g.tAos && ts <= g.tLos) {
        ctx.fillStyle = COLORS.rx
        ctx.beginPath()
        ctx.arc(x(ts), y(dopplerHz(mhz, rangeRate(g, ts))), 6 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
    },
    [slotId],
  )
  return <canvas ref={ref} className="fill" />
}

function Readout({ label, value, sub, hot }: { label: string; value: string; sub?: string; hot?: boolean }) {
  return (
    <div className={hot ? 'readout hot' : 'readout'}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}

export function TelemetryView() {
  const l = useLink()
  const text = useStrings().telemetry
  const now = useTicker(100)
  const slot = activeSlot(l.state, now)
  const config = l.state?.config
  const g = slot && config ? geometryFor(slot.pass, config) : null
  const ts = slot && g ? satTimeAt(slot, g, now) : 0
  const look = g ? g.look(ts) : null
  const station = slot && config ? stationFor(slot.pass, config) : null
  const mhz = slot ? downlinkMHz(slot.pass.satellite) : 137.5
  const rr = g ? rangeRate(g, ts) : 0
  const doppler = dopplerHz(mhz, rr)
  const rec = slot && g ? recordingTime(slot, g, ts) : null
  const sign = (v: number) => (v >= 0 ? '+' : '−')

  return (
    <Display title="telemetry">
      <div className="telemetry">
        <div className="sky">
          <SkyPlot slotId={slot?.id ?? null} />
        </div>
        <div className="readouts">
          <Readout label={text.azimuth} value={look ? `${num(look.azimuth, 1)}°` : '—'} />
          <Readout label={text.elevation} value={look ? `${num(look.elevation, 1)}°` : '—'} hot={!!look && look.elevation > 0} />
          <Readout label={text.range} value={look ? `${num(look.range)} km` : '—'} />
          <Readout label={text.rangeRate} value={g ? `${sign(rr)}${num(Math.abs(rr), 2)} km/s` : '—'} />
          <Readout label={text.doppler} value={g ? `${sign(doppler)}${num(Math.abs(doppler) / 1000, 2)} kHz` : '—'} />
          <Readout label={text.downlink} value={g ? `${num(mhz + doppler / 1e6, 4)} MHz` : '—'} />
          <Readout label={text.pathLoss} value={look ? `${num(pathLossDb(look.range, mhz), 1)} dB` : '—'} />
          <Readout
            label={text.recorded}
            value={rec ? `${rec.toISOString().slice(11, 19)} UTC` : '—'}
            sub={rec ? rec.toISOString().slice(0, 10) : undefined}
          />
          <Readout
            label={text.station}
            value={station?.name ?? '—'}
            sub={station ? `${num(station.lat, 2)}° · ${num(station.lon, 2)}°` : undefined}
          />
          <Readout label={text.maxElevation} value={slot?.pass.max_altitude != null ? `${num(slot.pass.max_altitude)}°` : '—'} />
        </div>
        <div className="doppler">
          <DopplerPlot slotId={slot?.id ?? null} />
        </div>
      </div>
    </Display>
  )
}
