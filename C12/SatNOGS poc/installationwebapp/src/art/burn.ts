// The phrase words drawn into the received image, before the reveal: each at the row the image
// reaches when the satellite flies over that word on the globes, and left or right as it lies
// beside the track. Big letters cut into scan lines and shifted a little sideways strip by
// strip, like the rest of the signal, so a word arrives row by row with the picture.
// Only on screen: it's drawn on the display's copy in memory, the image files are never touched.
import { FONT } from '../colors.ts'
import { random } from './phrases.ts'

export const PHRASE_FONT_WEIGHT = 600

export interface ImageWord {
  text: string
  at: number // 0..1 down the image
  across: number // -1..1 left / right
}

export function burnWords(ctx: CanvasRenderingContext2D, w: number, h: number, words: ImageWord[], seed: number) {
  const rand = random(seed ^ 0x9e3779b9)
  const size = Math.max(12, Math.round(Math.min(w / 14, h / 14)))

  // the letters on a layer of their own
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lc = layer.getContext('2d')!
  lc.font = `${PHRASE_FONT_WEIGHT} ${size}px ${FONT}`
  lc.textAlign = 'left'
  lc.textBaseline = 'top'
  lc.lineJoin = 'round'
  lc.lineWidth = size * 0.1
  lc.strokeStyle = 'rgba(0, 0, 0, 0.55)' // dark edge: readable on bright clouds too
  lc.fillStyle = 'rgba(255, 244, 214, 0.92)'
  const bands: [number, number][] = []
  for (const word of words) {
    const text = word.text.toUpperCase()
    const width = lc.measureText(text).width
    const room = Math.max(0, w / 2 - width / 2 - w * 0.04)
    const x = w / 2 + word.across * room - width / 2
    const y = Math.min(h - size * 1.2, Math.max(0, word.at * h))
    lc.strokeText(text, x, y)
    lc.fillText(text, x, y)
    bands.push([Math.max(0, Math.floor(y - size * 0.2)), Math.min(h, Math.ceil(y + size * 1.3))])
  }

  for (const [from, to] of bands) glitch(ctx, layer, from, to, size, rand)
}

// The signal look of the letters, shared by the image and the NOAA waterfall: scan lines cut
// through rows from..to of `layer`, then those rows copied onto `target` in thin strips, each a
// little off sideways. `size` is the letters' font size.
export function glitch(
  target: CanvasRenderingContext2D,
  layer: HTMLCanvasElement,
  from: number,
  to: number,
  size: number,
  rand: () => number,
) {
  const lc = layer.getContext('2d')!
  const period = Math.max(3, Math.round(size / 14))
  const strip = Math.max(2, Math.round(size / 20))
  lc.save()
  lc.globalCompositeOperation = 'destination-out'
  lc.fillStyle = 'rgba(0, 0, 0, 0.5)'
  for (let y = from; y < to; y += period) lc.fillRect(0, y, layer.width, Math.max(1, Math.round(period / 3)))
  lc.restore()
  for (let y = from; y < to; y += strip) {
    const dx = (rand() - 0.5) * size * 0.08
    target.drawImage(layer, 0, y, layer.width, strip, dx, y, layer.width, strip)
  }
}
