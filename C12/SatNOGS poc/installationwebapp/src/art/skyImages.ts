// The sky photos on the displays: a photo at the size a view needs, and what the views make of
// it: its dome (the photo as an all-sky camera pointed straight up would see it: the sky plot)
// and thin strips (the passes board).
// Everything is drawn in memory; the files in ../sky_images are never changed.
//
// Photos decode one at a time: without sharp on the server they arrive full size (up to 24
// megapixels), and two displays on a 4 GB computer decoding several of those at once is a lot.
import { useEffect, useState } from 'react'
import { reportError } from '../errors.ts'
import { skyUrl, skyWidth } from './sky.ts'

const KEEP = 8 // decoded photos kept (the views of one display use two or three sizes)

const bitmaps = new Map<string, Promise<ImageBitmap>>()
let queue: Promise<unknown> = Promise.resolve()

export function loadSky(file: string, width: number): Promise<ImageBitmap> {
  const w = skyWidth(width)
  const key = `${file}|${w}`
  let job = bitmaps.get(key)
  if (job) {
    bitmaps.delete(key) // most recently used last
    bitmaps.set(key, job)
    return job
  }
  job = queue
    .catch(() => {})
    .then(async () => {
      const res = await fetch(skyUrl(file, w))
      if (!res.ok) throw new Error(`sky photo ${file}: HTTP ${res.status}`)
      // scaled while decoding, keeping its proportions (and its EXIF orientation)
      return createImageBitmap(await res.blob(), { resizeWidth: w, resizeQuality: 'medium' })
    })
  queue = job
  bitmaps.set(key, job)
  job.catch(() => bitmaps.delete(key))
  while (bitmaps.size > KEEP) bitmaps.delete(bitmaps.keys().next().value!)
  return job
}

// a photo for a view: null until it's decoded (or with no photo)
export function useSky(file: string | null, width: number): ImageBitmap | null {
  const key = file ? `${file}|${skyWidth(width)}` : ''
  const [loaded, setLoaded] = useState<{ key: string; image: ImageBitmap } | null>(null)
  useEffect(() => {
    if (!file) return
    let alive = true
    loadSky(file, width).then(
      (image) => alive && setLoaded({ key, image }),
      (e) => reportError('sky photo', e),
    )
    return () => {
      alive = false
    }
  }, [key])
  return loaded && loaded.key === key ? loaded.image : null
}

// How far from the zenith the dome's edge is, radians: the photo's middle fills most of the disc
// (an equidistant fisheye of a normal photo), its edges squeezed towards the horizon.
const DOME_EDGE = 1.15

const domes = new WeakMap<ImageBitmap, Map<number, HTMLCanvasElement>>()

// The photo as an all-sky camera: a disc `size` pixels across, zenith in the middle, horizon at
// the edge, darker towards the horizon, transparent outside.
export function skyDome(image: ImageBitmap, size: number): HTMLCanvasElement {
  const bySize = domes.get(image) ?? new Map<number, HTMLCanvasElement>()
  domes.set(image, bySize)
  const known = bySize.get(size)
  if (known) return known

  // the middle square of the photo
  const side = Math.min(image.width, image.height)
  const S = Math.max(2, Math.min(side, Math.round(size * 1.25)))
  const src = document.createElement('canvas')
  src.width = S
  src.height = S
  const sc = src.getContext('2d', { willReadFrequently: true })!
  sc.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, S, S)
  const from = sc.getImageData(0, 0, S, S).data

  const dome = document.createElement('canvas')
  dome.width = size
  dome.height = size
  const dc = dome.getContext('2d')!
  const out = dc.createImageData(size, size)
  const o = out.data
  const tanEdge = Math.tan(DOME_EDGE)
  const half = (S - 1) / 2
  for (let y = 0; y < size; y++) {
    const dy = ((y + 0.5) / size) * 2 - 1
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1
      const r = Math.hypot(dx, dy)
      if (r >= 1) continue // transparent
      // how far out in the photo this point of the sky is (per unit of disc radius)
      const k = r > 1e-6 ? Math.tan(r * DOME_EDGE) / tanEdge / r : DOME_EDGE / tanEdge
      const sx = half + dx * k * half
      const sy = half + dy * k * half
      // bilinear
      const x0 = Math.min(S - 2, Math.max(0, Math.floor(sx)))
      const y0 = Math.min(S - 2, Math.max(0, Math.floor(sy)))
      const fx = Math.min(1, Math.max(0, sx - x0))
      const fy = Math.min(1, Math.max(0, sy - y0))
      const i00 = (y0 * S + x0) * 4
      const i10 = i00 + 4
      const i01 = i00 + S * 4
      const i11 = i01 + 4
      const shade = 1 - 0.55 * r ** 3 // the horizon is darker
      const at = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = from[i00 + c] * (1 - fx) + from[i10 + c] * fx
        const bottom = from[i01 + c] * (1 - fx) + from[i11 + c] * fx
        o[at + c] = (top * (1 - fy) + bottom * fy) * shade
      }
      o[at + 3] = r > 0.97 ? (255 * (1 - r)) / 0.03 : 255 // soft rim
    }
  }
  dc.putImageData(out, 0, 0)
  bySize.set(size, dome)
  return dome
}

// a photo's dome for a view: null until ready
export function useSkyDome(file: string | null, size: number): HTMLCanvasElement | null {
  const image = useSky(file, size * 1.6)
  const [dome, setDome] = useState<{ image: ImageBitmap; dome: HTMLCanvasElement } | null>(null)
  useEffect(() => {
    if (!image) return
    // a frame later: the page keeps drawing while the photo is being turned into a dome
    const id = requestAnimationFrame(() => setDome({ image, dome: skyDome(image, size) }))
    return () => cancelAnimationFrame(id)
  }, [image, size])
  return dome && dome.image === image ? dome.dome : null
}

// A small copy of a photo as a URL, for CSS backgrounds: a full-size photo as a background
// would be decoded full size.
const strips = new Map<string, Promise<string>>()

function stripUrl(file: string): Promise<string> {
  let job = strips.get(file)
  if (!job) {
    job = loadSky(file, 640).then(
      (image) =>
        new Promise<string>((resolve, reject) => {
          const canvas = document.createElement('canvas')
          canvas.width = image.width
          canvas.height = image.height
          canvas.getContext('2d')!.drawImage(image, 0, 0)
          canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('sky strip'))), 'image/jpeg', 0.82)
        }),
    )
    strips.set(file, job)
    job.catch(() => strips.delete(file))
    // the passes board shows a dozen at most
    while (strips.size > 32) {
      const oldest = strips.keys().next().value!
      strips.get(oldest)!.then((url) => URL.revokeObjectURL(url), () => {})
      strips.delete(oldest)
    }
  }
  return job
}

export function useSkyStrip(file: string | null): string | null {
  const [loaded, setLoaded] = useState<{ file: string; url: string } | null>(null)
  useEffect(() => {
    if (!file) return
    let alive = true
    stripUrl(file).then(
      (url) => alive && setLoaded({ file, url }),
      (e) => reportError('sky strip', e),
    )
    return () => {
      alive = false
    }
  }, [file])
  return loaded && loaded.file === file ? loaded.url : null
}
