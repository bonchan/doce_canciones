// The sky photos (../sky_images): the sky seen from the ground, the other side of the clouds the
// satellites photograph. A share of the passes on the timeline get one (the "sky" setting, 0 to
// 100%), the same on every display: the photos come in one shuffled order (the same everywhere),
// so every photo is shown before any of them repeats. No DOM here: the server uses it too
// (core2's telemetry names the photo).
import { random } from './phrases.ts'

let orderKey = ''
let order: string[] = []

function shuffled(photos: string[]): string[] {
  const key = photos.join('|')
  if (key !== orderKey) {
    const rand = random(0x5c1e5)
    const list = [...photos]
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    orderKey = key
    order = list
  }
  return order
}

// Whether a slot gets a photo, for `percent` of them: spread evenly along the timeline (steps of
// the golden ratio), not in runs; at 50% about every other pass.
export const hasSky = (slotId: number, percent: number) => ((slotId * 0.6180339887498949) % 1) * 100 < percent

// the photo of a slot on the timeline, null for a pass without one
export function skyFor(slotId: number, photos: string[] | undefined, percent: number | undefined): string | null {
  if (!photos?.length || !hasSky(slotId, percent ?? 0)) return null
  const list = shuffled(photos)
  return list[slotId % list.length]
}

// the widths the server makes a photo in (a request is rounded up to one of these)
export const SKY_WIDTHS = [64, 640, 1280, 1920, 2560]

export const skyWidth = (width: number) => SKY_WIDTHS.find((w) => w >= width) ?? SKY_WIDTHS[SKY_WIDTHS.length - 1]

export const skyUrl = (file: string, width: number) => `/sky/${encodeURIComponent(file)}?w=${skyWidth(width)}`
