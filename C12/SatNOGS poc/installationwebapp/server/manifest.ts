// The pass library: one entry per downloads/<YYYYmmdd_HHMMSS>_<satellite>_<id>/ folder with images.
// Same rules as the webapp's manifest, plus the length of each recording.
import fs from 'node:fs'
import path from 'node:path'
import type { LibraryInfo, PassSummary } from '../src/shared/protocol.ts'
import type { Pass } from '../src/shared/types.ts'

// What an image is, without the observation id / time, so passes can be compared:
//   data_10842543_2024-12-28T17-08-58_MCIR.png        -> mcir         (NOAA station enhancement)
//   data_10842543_2024-12-28T17-08-58.png             -> normal
//   satnogs_<id>_<time>.png (apt_decode.py)           -> decoded
//   data_15105291_msu_mr_rgb_MCIR_map.png             -> mcir_map     (METEOR, SatDump products)
//   data_15095028_MSU-MR_Filled_msu_mr_rgb_MCIR.png   -> mcir_filled
function imageKind(file: string): { kind: string; label: string } {
  let name = file.replace(/\.[^.]+$/, '')
  if (/^satnogs_/i.test(name)) return { kind: 'decoded', label: 'Decoded' }
  name = name
    .replace(/%[0-9a-f]{2}/gi, '') // url-escaped leftovers, e.g. the "µ" of "3.9_µm"
    .replace(/^data_\d+_?/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[_-]?/, '')
  const filled = /^MSU-MR_Filled_/i.test(name)
  name = name.replace(/^(rgb_)?(MSU-MR_(Filled_)?)?(msu_mr_(rgb_)?)?/i, '')
  if (!name) return { kind: 'normal', label: 'Normal' }
  if (filled) name += '_filled'
  return { kind: name.toLowerCase(), label: name.replace(/_+/g, ' ') }
}

// observation.json as written by listener.py
type ObservationJson = Partial<Pass> & { station_lat?: number; station_lng?: number }

function readJson(file: string): ObservationJson {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function stat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null // removed while scanning
  }
}

// Seconds of audio in an Ogg Vorbis / Opus file: sample rate from the first page,
// samples from the granule position of the last one. Cached per file version.
const durations = new Map<string, number | null>()

function audioSeconds(file: string): number | null {
  const st = stat(file)
  if (!st) return null
  const key = `${file}|${st.size}|${st.mtimeMs}`
  if (!durations.has(key)) durations.set(key, readOggSeconds(file, st.size))
  return durations.get(key) ?? null
}

function readOggSeconds(file: string, size: number): number | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(Math.min(size, 8192))
    fs.readSync(fd, head, 0, head.length, 0)
    let rate = 0
    let preSkip = 0
    const vorbis = head.indexOf('\x01vorbis', 0, 'latin1')
    const opus = head.indexOf('OpusHead', 0, 'latin1')
    if (vorbis >= 0) rate = head.readUInt32LE(vorbis + 12)
    else if (opus >= 0) {
      rate = 48000 // opus granules are always 48 kHz
      preSkip = head.readUInt16LE(opus + 10)
    }
    if (!rate) return null
    const tail = Buffer.alloc(Math.min(size, 65536))
    if (tail.length < 27) return null
    fs.readSync(fd, tail, 0, tail.length, size - tail.length)
    // last page that ends a packet (granule -1 = none does)
    let i = tail.lastIndexOf('OggS', tail.length - 4, 'latin1')
    while (i >= 0) {
      if (i + 14 <= tail.length) {
        const granule = tail.readBigUInt64LE(i + 6)
        if (granule !== 0xffffffffffffffffn) return Math.max(0, Number(granule) - preSkip) / rate
      }
      i = i > 0 ? tail.lastIndexOf('OggS', i - 1, 'latin1') : -1
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function scanPasses(downloads: string): Pass[] {
  if (!fs.existsSync(downloads)) return []
  const passes: Pass[] = []
  for (const dir of fs.readdirSync(downloads, { withFileTypes: true })) {
    const m = dir.isDirectory() && dir.name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(.+)_(\d+)$/)
    if (!m) continue
    const folder = path.join(downloads, dir.name)
    const files = fs.readdirSync(folder).sort()
    // listener.py writes observation.json last: without it and with fresh files it's still downloading
    if (!files.includes('observation.json')) {
      const newest = Math.max(0, ...files.map((f) => stat(path.join(folder, f))?.mtimeMs ?? 0))
      if (Date.now() - newest < 120_000) continue
    }
    const meta = readJson(path.join(folder, 'observation.json'))
    const url = (f: string) => `/data/${encodeURIComponent(dir.name)}/${encodeURIComponent(f)}`
    const seen = new Map<string, number>()
    const images = files
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => {
        const { kind, label } = imageKind(f)
        const n = (seen.get(kind) ?? 0) + 1
        seen.set(kind, n)
        const bytes = stat(path.join(folder, f))?.size ?? 0
        return n > 1
          ? { kind: `${kind}-${n}`, label: `${label} ${n}`, file: f, url: url(f), bytes }
          : { kind, label, file: f, url: url(f), bytes }
      })
    if (!images.length) continue
    const satellite = meta.satellite ?? m[7]
    // METEOR LRPT is digital: its recording is noise, only APT audio is worth playing
    const apt = meta.mode ? meta.mode === 'APT' : /^NOAA/i.test(satellite)
    const audio = apt ? files.find((f) => /\.(ogg|wav|mp3)$/i.test(f)) : undefined
    passes.push({
      id: meta.id ?? Number(m[8]),
      folder: dir.name,
      satellite,
      norad_cat_id: meta.norad_cat_id ?? null,
      mode: meta.mode ?? (apt ? 'APT' : null),
      start: meta.start ?? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
      end: meta.end ?? null,
      max_altitude: meta.max_altitude ?? null,
      rise_azimuth: meta.rise_azimuth ?? null,
      set_azimuth: meta.set_azimuth ?? null,
      station_id: meta.station_id ?? null,
      station_name: meta.station_name ?? null,
      station:
        meta.station_lat != null && meta.station_lng != null
          ? { name: meta.station_name ?? `station ${meta.station_id}`, lat: meta.station_lat, lon: meta.station_lng }
          : null,
      url: meta.url ?? null,
      images,
      audio: audio ? url(audio) : null,
      audio_seconds: audio && /\.ogg$/i.test(audio) ? audioSeconds(path.join(folder, audio)) : null,
    })
  }
  return passes.sort((a, b) => a.start.localeCompare(b.start))
}

export function libraryInfo(passes: Pass[]): LibraryInfo {
  const satellites: Record<string, number> = {}
  for (const p of passes) satellites[p.satellite] = (satellites[p.satellite] ?? 0) + 1
  return { passes: passes.length, stations: new Set(passes.map((p) => p.station_name ?? '?')).size, satellites }
}

export const summary = (p: Pass): PassSummary => ({
  id: p.id,
  satellite: p.satellite,
  station_name: p.station_name,
  start: p.start,
  max_altitude: p.max_altitude,
  audio: !!p.audio,
  kinds: p.images.map((i) => i.kind),
})
