import { useEffect, useRef } from 'react'
import { PHRASE_FONT_WEIGHT, burnWords, type ImageWord } from '../art/burn.ts'
import { phraseSeed } from '../art/phrases.ts'
import { usePathWords } from '../art/usePathWords.ts'
import { FONT } from '../colors.ts'
import { Display } from '../components/Display.tsx'
import { fmt, useStrings } from '../i18n.ts'
import { DEFAULT_IMAGE, imageGroup, kindLabel, pickImage } from '../images.ts'
import { link, liveSlot, useLink, useTicker } from '../link.ts'
import { activeSlot, countdown, phaseAt, progressAt, recorded } from '../timeline.ts'

const NOISE_ROWS = 6

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
function ImageReceiver(props: { slotId: number; url: string; words: ImageWord[] | null; seed: number }) {
  const { slotId, url, words, seed } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let source: CanvasImageSource | null = null // the image, with the phrase burned in
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
    }
    el.src = url

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
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [slotId, url, words, seed])

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

  return (
    <Display title="reception">
      <div className="image-view">
        {slot && image && <ImageReceiver key={slot.id} slotId={slot.id} url={image.url} words={words} seed={seed} />}
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
