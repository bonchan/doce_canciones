// The phrase drawn into the received image, before the reveal: big letters cut into scan
// lines and shifted a little sideways strip by strip, like the rest of the signal. It arrives
// row by row with the picture, so halfway through only its top part can be read.
// Only on screen: it's drawn on the display's copy in memory, the image files are never touched.
import { FONT } from '../colors.ts'
import { random } from './phrases.ts'

export const PHRASE_FONT_WEIGHT = 600

export function burnPhrase(ctx: CanvasRenderingContext2D, w: number, h: number, phrase: string, seed: number) {
  const rand = random(seed ^ 0x9e3779b9)
  const size = Math.max(12, Math.round(Math.min(w / 12, h / 8)))
  const font = `${PHRASE_FONT_WEIGHT} ${size}px ${FONT}`

  // the letters on a layer of their own
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lc = layer.getContext('2d')!
  lc.font = font
  const lines = wrap(lc, phrase.toUpperCase(), w * 0.8)
  const lineHeight = size * 1.3
  const blockHeight = lines.length * lineHeight
  const top = h * 0.2 + rand() * Math.max(0, h * 0.6 - blockHeight) // somewhere in the middle
  lc.textAlign = 'center'
  lc.textBaseline = 'top'
  lc.lineJoin = 'round'
  lc.lineWidth = size * 0.1
  lc.strokeStyle = 'rgba(0, 0, 0, 0.55)' // dark edge: readable on bright clouds too
  lc.fillStyle = 'rgba(255, 244, 214, 0.92)'
  lines.forEach((line, i) => {
    lc.strokeText(line, w / 2, top + i * lineHeight)
    lc.fillText(line, w / 2, top + i * lineHeight)
  })

  // scan lines through the letters
  const from = Math.max(0, Math.floor(top - size * 0.2))
  const to = Math.min(h, Math.ceil(top + blockHeight + size * 0.2))
  const period = Math.max(3, Math.round(size / 14))
  lc.globalCompositeOperation = 'destination-out'
  lc.fillStyle = 'rgba(0, 0, 0, 0.5)'
  for (let y = from; y < to; y += period) lc.fillRect(0, y, w, Math.max(1, Math.round(period / 3)))

  // onto the image in thin strips, each one a little off sideways
  const strip = Math.max(2, Math.round(size / 20))
  for (let y = from; y < to; y += strip) {
    const dx = (rand() - 0.5) * size * 0.08
    ctx.drawImage(layer, 0, y, w, strip, dx, y, w, strip)
  }
}

// words into lines no wider than maxWidth (a single longer word gets a line of its own)
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}
