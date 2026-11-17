// The sky photos for the displays: listed from the folder in installation.json ("skyImages") and
// served at the width a display asks for, /sky/<file>?w=1280. Resized with sharp when it's
// installed (pnpm add sharp): the photos are up to 24 megapixels, too much for the displays'
// computers to decode over and over. Without it they go as they are, and each display scales
// them down itself (src/art/skyImages.ts), one at a time.
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { skyWidth } from '../src/art/sky.ts'

const PHOTO = /\.(jpe?g|png|webp)$/i
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const CACHE_MAX = 60 // resized photos kept in memory (a few hundred kB each)

export function scanSky(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && PHOTO.test(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return [] // no folder: no sky
  }
}

type Resize = (file: string, width: number) => Promise<Buffer>

let resizer: Promise<Resize | null> | null = null

// sharp, if it's installed (it isn't a dependency: the name in a variable keeps TypeScript and
// the bundler from requiring it)
function loadResizer(): Promise<Resize | null> {
  resizer ??= (async () => {
    try {
      const name = 'sharp'
      const sharp = (await import(name)).default
      sharp.concurrency(2) // the server's computer also runs two displays
      sharp.cache(false)
      console.log('[sky] photos resized with sharp')
      return (file: string, width: number) =>
        sharp(file).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer() as Promise<Buffer>
    } catch {
      console.log('[sky] sharp is not installed: photos are sent full size and the displays scale them (pnpm add sharp)')
      return null
    }
  })()
  return resizer
}

const resized = new Map<string, Promise<Buffer>>()

function sendFile(res: http.ServerResponse, file: string) {
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  fs.createReadStream(file)
    .on('error', () => {
      res.statusCode = 404
      res.end()
    })
    .pipe(res)
}

export async function serveSky(req: http.IncomingMessage, res: http.ServerResponse, dir: string, photos: string[]) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let name = ''
  try {
    name = decodeURIComponent(url.pathname.replace(/^\/sky\//, ''))
  } catch {
    // bad escape: not one of ours
  }
  // only the listed photos: nothing else of the disk is reachable from here
  if (!photos.includes(name)) {
    res.statusCode = 404
    return void res.end('not found')
  }
  const file = path.join(dir, name)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    res.statusCode = 404
    return void res.end('not found')
  }
  const resize = await loadResizer()
  if (!resize) return sendFile(res, file)

  const width = skyWidth(Number(url.searchParams.get('w')) || 1280)
  const key = `${name}|${width}|${stat.mtimeMs}`
  let job = resized.get(key)
  if (!job) {
    job = resize(file, width)
    resized.set(key, job)
    if (resized.size > CACHE_MAX) resized.delete(resized.keys().next().value!)
    job.catch(() => resized.delete(key))
  }
  try {
    const jpeg = await job
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(jpeg)
  } catch (e) {
    console.error(`[sky] ${name}:`, e)
    sendFile(res, file) // unreadable for sharp: let the browser try
  }
}
