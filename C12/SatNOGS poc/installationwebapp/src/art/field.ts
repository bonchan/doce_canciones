// The words floating around the Earth during one pass. Computed from the pass on the timeline
// (seed + orbit), so both globes and every reception display get exactly the same field:
//   - the phrase words lie along the satellite's path between AOS and LOS, anywhere across the
//     strip it scans: right of its direction of travel lands right in the image, left lands
//     left. Spread out in time so they land on separate rows of the image
//   - every other word of the vocabulary floats somewhere else, away from the track
// A new pass is a new seed and a new orbit: the same words, shuffled to new places.
import { EARTH_RADIUS_KM, bearing, destination, distanceKm, type GeoPoint, type PassGeometry } from '../orbit.ts'
import { phrases, random, type Vocabulary } from './phrases.ts'

export interface FieldWord {
  text: string
  lat: number // radians
  lon: number
  alt: number // km above the ground
  passAt: number | null // orbit time (s from culmination) the satellite flies over it; null: never
  at: number | null // the same as a fraction of the reception: the image row it starts at
  across: number // -1..1, left / right of the track: where it lands across the image
}

// half the strip a NOAA scanner sees (about 2900 km wide): phrase words lie up to this far
// either side of the ground track
const SWATH_KM = 1400
const KEEP_OUT_KM = 2200 // the other words stay at least this far from it

// around the satellite's own height, so the tracking camera sees them at its level
const floatAltitude = (g: PassGeometry, rand: () => number) => g.geo(0).alt + (rand() - 0.5) * 400

const cache = new WeakMap<PassGeometry, Map<string, FieldWord[]>>()

export function wordField(seed: number, vocabulary: Vocabulary, g: PassGeometry): FieldWord[] {
  const key = `${seed}|${vocabulary.words.join(',')}`
  let forGeometry = cache.get(g)
  if (!forGeometry) cache.set(g, (forGeometry = new Map()))
  const cached = forGeometry.get(key)
  if (cached) return cached

  const rand = random(seed ^ 0x51ed270b)
  const field: FieldWord[] = []
  const path = phrases.phrase(seed, vocabulary)
  const span = g.tLos - g.tAos
  path.forEach((text, i) => {
    // one slice of the pass per word (with a little play), leaving room at the end for the
    // last one to arrive whole before LOS
    const at = 0.08 + ((i + 0.5 + (rand() - 0.5) * 0.3) / path.length) * 0.74
    const passAt = g.tAos + at * span
    const here = g.geo(passAt)
    const heading = bearing(here, g.geo(passAt + 10))
    const across = (rand() * 2 - 1) * 0.95 // + right of the direction of travel, - left
    const [lat, lon] = destination(here.lat, here.lon, heading + Math.PI / 2, (across * SWATH_KM) / EARTH_RADIUS_KM)
    field.push({ text, lat, lon, alt: floatAltitude(g, rand), passAt, at, across })
  })

  const track: GeoPoint[] = []
  for (let t = g.tAos - 600; t <= g.tLos + 600; t += 60) track.push(g.geo(t))
  for (const text of new Set(vocabulary.words)) {
    if (path.includes(text)) continue
    let lat = 0
    let lon = 0
    for (let tries = 0; tries < 30; tries++) {
      lat = Math.asin(rand() * 2 - 1) // uniform over the sphere
      lon = rand() * 2 * Math.PI - Math.PI
      if (track.every((p) => distanceKm(p, { lat, lon }) > KEEP_OUT_KM)) break
    }
    field.push({ text, lat, lon, alt: floatAltitude(g, rand), passAt: null, at: null, across: 0 })
  }

  forGeometry.set(key, field)
  return field
}

// the phrase words, in the order the satellite reaches them
export interface PathWord {
  text: string
  at: number // fraction of the reception when it's reached
  across: number // -1..1, left / right of the track
}

export function pathWords(seed: number, vocabulary: Vocabulary, g: PassGeometry): PathWord[] {
  return wordField(seed, vocabulary, g).flatMap((w) => (w.at == null ? [] : [{ text: w.text, at: w.at, across: w.across }]))
}
