import { useEffect, useRef } from 'react'
import { random, textSeed } from '../art/phrases.ts'
import { skyFor } from '../art/sky.ts'
import { useSky } from '../art/skyImages.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { DISPLAY_ID } from '../params.ts'
import { CENIT_DEFAULTS, type CenitSettings } from '../shared/cenit.ts'
import type { CenitTest, Slot } from '../shared/protocol.ts'
import { activeSlot, culminationAt, geometryFor } from '../timeline.ts'

// At the top of every pass with a sky photo (its culmination: the satellite as high over the
// station as it gets) every screen looks up for a few seconds: the sky over the station seen from
// the ground, the other side of the clouds the satellite is photographing right then. Neither
// sees the other. The same photo on every display, each one a different window into it, all
// drifting with the same wind. The top bar stays: the pass goes on.
// Its settings (`cenit`, src/shared/cenit.ts): on / off, fade in, hold, fade out, opacity, zoom,
// drift, the shortest pass it stops on. A test (the operator page, core2's CENIT) shows it right
// away on every display with those settings, switched off too, and on a pass without a sky
// photo (then with the one it would have had at 100%).

const settings = (): CenitSettings => link.state?.config.cenit ?? CENIT_DEFAULTS

// the photo's size for it: big enough for the zoomed window on this screen
export const cenitWidth = () =>
  Math.max(window.innerWidth, window.innerHeight * 1.5) * (window.devicePixelRatio || 1) * (settings().zoom / 100)

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

interface Moment {
  level: number // 0 (not at all) to its opacity
  through: number // how far through the moment, 0 to 1
}
const NONE: Moment = { level: 0, through: 0 }

// the moment `dt` ms after it starts fading in
function moment(dt: number, c: CenitSettings): Moment {
  const fadeIn = c.fadeIn * 1000
  const hold = c.hold * 1000
  const fadeOut = c.fadeOut * 1000
  const total = fadeIn + hold + fadeOut
  const through = dt / total
  if (!(total > 0) || through <= 0 || through >= 1) return NONE
  const peak = c.opacity / 100
  if (dt < fadeIn) return { level: ease(dt / fadeIn) * peak, through }
  if (dt < fadeIn + hold) return { level: peak, through }
  return { level: ease(1 - (dt - fadeIn - hold) / fadeOut) * peak, through }
}

// how far the screens are looking up at t on pass s (the tests aside)
export function cenitAt(s: Slot, t: number): Moment {
  const config = link.state?.config
  const c = settings()
  if (!config || !c.on || !skyFor(s.id, link.state?.sky, config.sky) || s.los - s.aos < c.minPass * 1000) return NONE
  const start = culminationAt(s, geometryFor(s.pass, config)) - (c.hold * 1000) / 2 - c.fadeIn * 1000
  return moment(t - start, c)
}

// The tests at t. Each starts when asked for, the same instant on every display, or, on a display
// still decoding the photo, as soon as it has it.
const started = new WeakMap<CenitTest, number>()

function testAt(t: number): Moment {
  let best = NONE
  for (const test of link.cenitTests) {
    let start = started.get(test)
    if (start == null) {
      if (t > test.at + 20_000) continue // too late for it
      started.set(test, (start = Math.max(test.at, t)))
    }
    const m = moment(t - start, settings())
    if (m.level > best.level) best = m
  }
  return best
}

// where this display's window into the photo is (-1..1 each way): the same every time
const windowRand = random(textSeed(DISPLAY_ID))
const WINDOW: [number, number] = [windowRand() * 2 - 1, windowRand() * 2 - 1]

export function Cenit() {
  const l = useLink()
  const now = useTicker(1000)
  const slot = activeSlot(l.state, now)
  const slotId = slot?.id ?? null
  const c = l.state?.config.cenit ?? CENIT_DEFAULTS
  // the pass's photo; for a test on a pass without one, the one it would have had at 100%
  const sky = slot ? skyFor(slot.id, l.state?.sky, l.state?.config.sky) : null
  const testWindow = (c.fadeIn + c.hold + c.fadeOut) * 1000 + 20_000
  const testing = l.cenitTests.some((test) => test.at > now - testWindow)
  const file = sky ?? (testing ? skyFor(slotId ?? 0, l.state?.sky, 100) : null)
  const image = useSky(file, cenitWidth())
  const real = !!sky && file === sky // the pass's own: it comes on its own at the top of the pass
  const zoom = c.zoom / 100
  const layerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // this display's window into the photo, drawn once (and again if the screen changes size)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const paint = () => {
      const dpr = window.devicePixelRatio || 1
      const W = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const H = Math.max(1, Math.round(canvas.clientHeight * dpr))
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')!
      const k = Math.max(W / image.width, H / image.height) * zoom
      const w = image.width * k
      const h = image.height * k
      ctx.drawImage(image, ((W - w) / 2) * (1 - WINDOW[0]), ((H - h) / 2) * (1 - WINDOW[1]), w, h)
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [image, zoom])

  // the moment: opacity and the slow drift, every frame (only the compositor works while it's off)
  useEffect(() => {
    const layer = layerRef.current
    const canvas = canvasRef.current
    if (!layer || !canvas) return
    const wind = random(slotId ?? 0)() * Math.PI * 2 // the same on every display
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const t = link.now()
      const s = liveSlot(slotId)
      const own = image && real && s ? cenitAt(s, t) : NONE
      const test = image ? testAt(t) : NONE
      const { level, through } = test.level > own.level ? test : own
      if (level <= 0) {
        if (layer.style.display !== 'none') layer.style.display = 'none'
        return
      }
      layer.style.display = ''
      layer.style.opacity = level.toFixed(3)
      // drifting with the wind (%), zooming slowly out, never showing an edge
      const drift = settings().drift
      const d = (through - 0.5) * drift
      const scale = Math.max(1.09 - 0.05 * through, 1 / (1 - drift / 100) + 0.01)
      canvas.style.transform = `scale(${scale.toFixed(4)}) translate(${(Math.cos(wind) * d).toFixed(3)}%, ${(Math.sin(wind) * d).toFixed(3)}%)`
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [slotId, image, real])

  return (
    <div ref={layerRef} className="cenit" style={{ display: 'none' }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
