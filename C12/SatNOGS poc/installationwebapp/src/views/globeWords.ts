// The field's words floating around the Earth (src/art/field.ts), the same on both globes.
// Each word stands upright on the Earth (its vertical points away from the centre) and has a
// real size, so the tracking camera sees the words ahead grow as it flies towards them.
// When the pass changes the same words drift to their new places; a phrase word lights up
// when the satellite flies over it, the moment it starts arriving in the image.
import * as Cesium from 'cesium'
import type { FieldWord } from '../art/field.ts'
import { COLORS, FONT } from '../colors.ts'

const WORD_HEIGHT_M = 380_000
const WORD_WIDEN = 2 // letters stretched sideways: 3x wider than the font draws them
// Cesium packs a billboard's width and height into 16 bits: in metres they can't go past
// 65 535, bigger values get cut down (tiny, squashed words). So each word is drawn small enough
// to fit and scaled up to its real size; the scale has no such limit.
const MAX_BILLBOARD_M = 60_000
const MOVE_MS = 2500 // the shuffle (the orbit camera flies to the new station in 2 s)
const LIT_SCALE = 1.05 // a word the satellite has reached grows to twice its size and stays so
const GROW_MS = 900

const UNLIT = Cesium.Color.fromCssColorString(COLORS.text).withAlpha(0.9)
const LIT = Cesium.Color.fromCssColorString(COLORS.rx)

interface Spot {
  lat: number // radians
  lon: number
  alt: number // km
}

interface Item {
  from: Spot
  to: Spot
  start: number // when it started moving (performance.now)
  passAt: number | null
  litAt: number | null
  rotation: number // the last good angle on screen
  baseScale: number // drawn size -> real size (see MAX_BILLBOARD_M)
}

const scratchUp = new Cesium.Cartesian3()
const scratchTop = new Cesium.Cartesian3()
const scratchA = new Cesium.Cartesian2()
const scratchB = new Cesium.Cartesian2()

// ease out with a little overshoot past the end
const easeOutBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

// white letters with a dark edge; Cesium tints them (unlit, or lit)
function wordImage(text: string) {
  const size = 96
  const font = `600 ${size}px ${FONT}`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const spaced = () => {
    ctx.font = font
    ctx.letterSpacing = `${size * 0.15}px` // airy: easier to read from far away
  }
  spaced()
  canvas.width = Math.ceil(ctx.measureText(text).width + size * 0.6)
  canvas.height = Math.ceil(size * 1.35)
  spaced() // resizing the canvas reset it
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = size * 0.12
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2)
  ctx.fillStyle = '#fff'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  return canvas
}

export class GlobeWords {
  private source = new Cesium.CustomDataSource('words')
  private items = new Map<string, { item: Item; entity: Cesium.Entity }>()
  private satT: () => number = () => -Infinity
  private scene: Cesium.Scene

  constructor(viewer: Cesium.Viewer) {
    this.scene = viewer.scene
    viewer.dataSources.add(this.source)
  }

  // the field of a new pass; satT: the orbit time of the satellite right now
  show(field: FieldWord[], satT: () => number) {
    const now = performance.now()
    this.satT = satT
    const texts = new Set(field.map((w) => w.text))
    for (const [text, { entity }] of this.items) {
      if (texts.has(text)) continue
      this.source.entities.remove(entity) // another language: other words
      this.items.delete(text)
    }
    for (const w of field) {
      const to = { lat: w.lat, lon: w.lon, alt: w.alt }
      const known = this.items.get(w.text)
      if (known) {
        known.item.from = this.spot(known.item, now)
        known.item.to = to
        known.item.start = now
        known.item.passAt = w.passAt
        known.item.litAt = null
      } else {
        this.add(w.text, { from: to, to, start: now, passAt: w.passAt, litAt: null, rotation: 0, baseScale: 1 })
      }
    }
  }

  clear() {
    this.source.entities.removeAll()
    this.items.clear()
  }

  // where it is now: on its way from the old place to the new one
  private spot(item: Item, now: number): Spot {
    const f = ease(Math.min(1, Math.max(0, (now - item.start) / MOVE_MS)))
    const dLon = Math.atan2(Math.sin(item.to.lon - item.from.lon), Math.cos(item.to.lon - item.from.lon)) // the short way
    return {
      lat: item.from.lat + (item.to.lat - item.from.lat) * f,
      lon: item.from.lon + dLon * f,
      alt: item.from.alt + (item.to.alt - item.from.alt) * f,
    }
  }

  private position(item: Item) {
    const s = this.spot(item, performance.now())
    return Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.alt * 1000)
  }

  // Upright on the Earth: turn the word on screen so its vertical points the way "away from
  // the centre" points from where it is (from the projection of a point 1000 km above it)
  private rotation(item: Item) {
    // once the satellite reaches it, it keeps the angle it had at that moment
    if (this.lit(item)) return item.rotation
    const base = this.position(item)
    const top = Cesium.Cartesian3.add(
      base,
      Cesium.Cartesian3.multiplyByScalar(Cesium.Cartesian3.normalize(base, scratchUp), 1_000_000, scratchUp),
      scratchTop,
    )
    const a = this.scene.cartesianToCanvasCoordinates(base, scratchA)
    const b = a && this.scene.cartesianToCanvasCoordinates(top, scratchB)
    if (a && b && (a.x !== b.x || a.y !== b.y)) {
      // canvas y grows downwards; the billboard turns counter-clockwise from screen-up
      const angle = Math.atan2(-(b.x - a.x), -(b.y - a.y))
      if (Number.isFinite(angle)) item.rotation = angle
    }
    return item.rotation
  }

  // the satellite has flown over it (in this pass)
  private lit(item: Item) {
    const lit = item.passAt != null && this.satT() >= item.passAt
    if (!lit) item.litAt = null
    else if (item.litAt == null) item.litAt = performance.now()
    return lit
  }

  private add(text: string, item: Item) {
    const image = wordImage(text.toUpperCase())
    const aspect = (WORD_WIDEN * image.width) / image.height
    const height = Math.min(1_000, MAX_BILLBOARD_M / aspect)
    item.baseScale = WORD_HEIGHT_M / height
    const entity = this.source.entities.add({
      position: new Cesium.CallbackPositionProperty(() => this.position(item), false),
      billboard: {
        image,
        sizeInMeters: true,
        height,
        width: height * aspect,
        rotation: new Cesium.CallbackProperty(() => this.rotation(item), false),
        color: new Cesium.CallbackProperty(() => (this.lit(item) ? LIT : UNLIT), false),
        scale: new Cesium.CallbackProperty(() => {
          if (!this.lit(item) || item.litAt == null) return item.baseScale
          const f = easeOutBack(Math.min(1, (performance.now() - item.litAt) / GROW_MS))
          return item.baseScale * (1 + (LIT_SCALE - 1) * f)
        }, false),
      },
    })
    this.items.set(text, { item, entity })
  }
}
