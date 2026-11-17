import { useEffect, useRef } from 'react'
import { PHRASE_FONT_WEIGHT, burnWords, type ImageWord } from '../art/burn.ts'
import { phraseSeed } from '../art/phrases.ts'
import { skyFor } from '../art/sky.ts'
import { loadSky } from '../art/skyImages.ts'
import { usePathWords } from '../art/usePathWords.ts'
import { FONT } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { reportError } from '../errors.ts'
import { fmt, useStrings } from '../i18n.ts'
import { DEFAULT_IMAGE, imageGroup, kindLabel, pickImage } from '../images.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { activeSlot, countdown, phaseAt, progressAt, recorded } from '../timeline.ts'

const NOISE_ROWS = 6

// The other side of the clouds: behind the scan line, the sky photographed from the ground
// develops wherever the satellite saw cloud (and in the phrase's letters, as bright). It's a
// second line that sets off a while after AOS and runs faster than the scan line; it catches up
// with it near the end, and from there both sides of the cloud arrive together until LOS.
const SKY_LAG = 0.18 // of the pass: when the sky line sets off
const SKY_MEET = 0.92 // of the pass: when it reaches the scan line
const SKY_SOFT = 0.07 // of the image's height: its soft edge
const SKY_ALPHA = 0.9 // the most the sky covers a white cloud

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

// The sky inside the image's clouds: the photo, mirrored (it's seen from the other side), opaque
// where the image is bright and gone where it's dark. Same size as the image.
function cloudSky(image: CanvasImageSource, sky: ImageBitmap, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, w, h)
  const bright = ctx.getImageData(0, 0, w, h).data
  ctx.clearRect(0, 0, w, h)
  const k = Math.max(w / sky.width, h / sky.height)
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(sky, (w - sky.width * k) / 2, (h - sky.height * k) / 2, sky.width * k, sky.height * k)
  ctx.restore()
  const px = ctx.getImageData(0, 0, w, h)
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * bright[i] + 0.7152 * bright[i + 1] + 0.0722 * bright[i + 2]) / 255
    d[i + 3] = 255 * smooth((lum - 0.38) / 0.5)
  }
  ctx.putImageData(px, 0, 0)
  return canvas
}

function makeNoise(ctx: CanvasRenderingContext2D, width: number, count = 4) {
  return Array.from({ length: count }, () => {
    const img = ctx.createImageData(width, NOISE_ROWS)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 200
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    return img
  })
}

// The image revealed top-down in chunks of rows as the reception progresses.
// Keyed on the url and the words: every state message brings new (equal) pass objects.
function ImageReceiver(props: { slotId: number; url: string; words: ImageWord[] | null; seed: number; sky: string | null }) {
  const { slotId, url, words, seed, sky } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let source: CanvasImageSource | null = null // the image, with the phrase burned in
    let skyPhoto: ImageBitmap | null = null
    let clouds: HTMLCanvasElement | null = null // the sky inside its clouds (cloudSky)
    let developed = 0 // rows with all the sky they get
    let W = 0
    let H = 0
    let alive = true
    let noise: ImageData[] = []
    let chunk = 12
    let drawn = 0
    let frame = 0
    let raf = 0

    const el = new Image()
    el.onload = async () => {
      let composite: CanvasImageSource = el
      if (words?.length) {
        try {
          await document.fonts.load(`${PHRASE_FONT_WEIGHT} 32px ${FONT}`)
        } catch {
          // drawn with a fallback font
        }
        if (!alive) return
        const c = document.createElement('canvas')
        c.width = el.naturalWidth
        c.height = el.naturalHeight
        const cc = c.getContext('2d')!
        cc.drawImage(el, 0, 0)
        burnWords(cc, c.width, c.height, words, seed)
        composite = c
      }
      W = el.naturalWidth
      H = el.naturalHeight
      canvas.width = W
      canvas.height = H
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      noise = makeNoise(ctx, W)
      chunk = Math.max(4, Math.round(H / 160))
      source = composite
      drawn = 0
      developed = 0
      makeClouds()
    }
    el.src = url

    // the image and the photo, whichever arrives last (a frame later: it takes a moment)
    const makeClouds = () => {
      if (!source || !skyPhoto || clouds) return
      const image = source
      const photo = skyPhoto
      requestAnimationFrame(() => {
        if (!alive || source !== image) return
        try {
          clouds = cloudSky(image, photo, W, H)
          developed = 0
        } catch (e) {
          reportError('sky in the image', e)
        }
      })
    }
    if (sky) {
      loadSky(sky, 1920).then(
        (photo) => {
          if (!alive) return
          skyPhoto = photo
          makeClouds()
        },
        (e) => reportError('sky photo', e),
      )
    }

    // rows from..to: the image, and the sky over it as much as `alpha`
    const paint = (from: number, to: number, alpha: number) => {
      if (to <= from || !source) return
      ctx.drawImage(source, 0, from, W, to - from, 0, from, W, to - from)
      if (clouds && alpha > 0.002) {
        ctx.globalAlpha = alpha
        ctx.drawImage(clouds, 0, from, W, to - from, 0, from, W, to - from)
        ctx.globalAlpha = 1
      }
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (!source) return
      const s = liveSlot(slotId)
      const t = link.now()
      const phase = s ? phaseAt(s, t) : 'depart'
      const receiving = phase === 'pass'
      const rows =
        phase === 'depart' ? H : s && receiving ? Math.min(H, Math.floor((progressAt(s, t) * H) / chunk) * chunk) : 0
      if (rows < drawn) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, W, H)
        drawn = 0
        developed = 0
      }
      if (rows > drawn || receiving) {
        // wipe the previous noise strip before laying down real rows
        ctx.fillStyle = '#000'
        ctx.fillRect(0, drawn, W, Math.min(H, rows + NOISE_ROWS) - drawn)
        if (rows > drawn) ctx.drawImage(source, 0, drawn, W, rows - drawn, 0, drawn, W, rows - drawn)
        drawn = rows
      }
      if (receiving && rows < H) {
        ctx.putImageData(noise[frame++ % noise.length], 0, rows)
        ctx.fillStyle = '#ffcf4a'
        ctx.fillRect(0, rows, W, 2)
      }

      // the sky line, never past the rows that have arrived
      if (clouds) {
        const p = phase === 'depart' ? 1 : s && receiving ? progressAt(s, t) : 0
        const soft = SKY_SOFT * H
        // the line's leading (faintest) edge; full sky `soft` rows behind it. At SKY_MEET the full
        // part reaches the scan line, and from there rides with it
        const front =
          p < SKY_MEET ? (Math.max(0, p - SKY_LAG) / (SKY_MEET - SKY_LAG)) * (SKY_MEET * H + soft) : p * H + soft
        const done = Math.max(0, Math.min(rows, Math.floor(front - soft)))
        if (done < developed) developed = 0
        if (done > developed) {
          paint(developed, done, SKY_ALPHA)
          developed = done
        }
        const strip = Math.max(2, Math.round(soft / 24))
        const edge = Math.min(rows, Math.ceil(front))
        for (let y = developed; y < edge; y += strip) {
          const to = Math.min(edge, y + strip)
          paint(y, to, SKY_ALPHA * smooth((front - (y + to) / 2) / soft))
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [slotId, url, words, seed, sky])

  return <canvas ref={canvasRef} className="rx-image" />
}

export function ImageView() {
  const l = useLink()
  const text = useStrings()
  const now = useTicker(250)
  const slot = activeSlot(l.state, now)
  const config = l.state?.config
  const group = slot ? imageGroup(slot.pass) : 'NOAA'
  const image = slot && config ? pickImage(slot.pass, config.images[group] ?? DEFAULT_IMAGE[group] ?? 'normal') : null
  const phase = slot ? phaseAt(slot, now) : null
  // the phrase words: each arrives in the image as the satellite flies over it on the globes
  const seed = slot ? phraseSeed(slot.id, slot.pass.id) : 0
  const words = usePathWords(slot)
  const sky = slot ? skyFor(slot.id, l.state?.sky, config?.sky) : null

  return (
    <Display title="reception">
      <div className="image-view">
        {slot && image && <ImageReceiver key={slot.id} slotId={slot.id} url={image.url} words={words} seed={seed} sky={sky} />}
        {slot && (phase === 'waiting' || phase === 'approach') && (
          <div className="standby">
            <div className="standby-phase">{phase === 'waiting' ? text.image.nextPass : text.image.acquiring}</div>
            <div className="standby-sat">{slot.pass.satellite}</div>
            <div className="dim">{slot.pass.station_name ?? text.common.unknownStation}</div>
            <div className="standby-count">{fmt(text.image.aos, { countdown: countdown(slot.aos - now) })}</div>
          </div>
        )}
        {slot && image && (
          <div className="caption">
            {fmt(text.image.caption, {
              kind: (text.image.kinds as Record<string, string>)[image.kind] ?? kindLabel(image),
              date: recorded(slot.pass),
            })}
          </div>
        )}
      </div>
    </Display>
  )
}
