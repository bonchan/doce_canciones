// Finished real passes into the library. Once raspberry_sat has decoded a pass (a few minutes after
// LOS) it goes into downloads/ the way listener.py's passes do, and from then on it's replayed like
// the others (orbit worked out from its highest elevation and directions, the image scanning in),
// right after the slot on air if the settings say so (receiver.playImported; index.ts: one from
// before the server started joins the end of the list).
//
// What comes: the image kind shown for its satellite family (the operator page's image setting,
// else the default one, src/images.ts), and the receiver's main image as well when it's another
// (its best: the next one when the first is black); both as the receiver's screen-sized JPEGs.
// And its signal over the pass (signal.json): its replays draw the real SNR and the sync on the
// sky track (src/views/LiveCharts.tsx).
//
// One folder per pass, named from its start like the others, the id its start in unix seconds (no
// SatNOGS observation id comes near). Written in a hidden folder first and renamed when complete,
// so a scan never sees half of one.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_IMAGE, imageGroup, pickImage } from '../src/images.ts'
import type { Pass, PassImage } from '../src/shared/types.ts'
import type { InstallationConfig } from './config.ts'
import { imageKind } from './manifest.ts'

const CHECK_EVERY = 60_000
const RECENT_S = 6 * 3600 // passes this recent (by their start) are imported
const RETRY_AFTER = 10 * 60_000
const TIMEOUT = 60_000 // a large JPEG is made on the Pi the first time it's asked for

interface PiImage {
  path: string // inside the pass's folder, e.g. MSU-MR/msu_mr_rgb_MCIR_corrected.png
  width?: number
  height?: number
  error?: string
  gone?: boolean // deleted on the Pi after it went to a hub: only its thumbnail is left
}

interface PiPass {
  satellite: string
  time: number // unix seconds
  main?: string | null
  images?: PiImage[]
  orbit?: { aos?: number; los?: number; max_el?: number; aos_az?: number; los_az?: number } | null
  station?: { name?: string; lat?: number; lon?: number } | null
  samples?: { t: number; az?: number | null; el?: number | null; snr?: number; deframer_lock?: boolean | number }[]
}

export interface ImportStatus {
  last: { satellite: string; folder: string; at: number } | null
  error: string | null
}

const utcStamp = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
const folderFor = (time: number, satellite: string) => `${utcStamp(time)}_${satellite.replace(/[^\w.-]+/g, '-')}_${Math.round(time)}`

export function startImporter(o: { downloads: string; config: () => InstallationConfig; onImported: (id: number) => void }) {
  const status: ImportStatus = { last: null, error: null }
  const failed = new Map<string, number>() // the Pi's pass id -> when it last failed
  let busy = false
  const base = () => o.config().receiver.url.replace(/\/+$/, '')

  const get = async (p: string) => {
    const res = await fetch(base() + p, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`)
    return res
  }

  async function importPass(piId: string, folder: string, id: number) {
    const meta = (await (await get(`/api/passes/${encodeURIComponent(piId)}`)).json()) as PiPass
    const usable = (meta.images ?? []).filter((i) => !i.error && !i.gone && i.width && i.height)
    if (!usable.length) throw new Error('no images to take')
    // named as listener.py's: the library tells their kinds from the names (manifest.ts imageKind)
    const fileOf = (img: PiImage) => `data_${id}_${path.posix.basename(img.path).replace(/\.[^.]+$/, '')}.jpg`
    const listed: PassImage[] = usable.map((img) => ({ ...imageKind(fileOf(img)), file: fileOf(img), url: '', bytes: img.width! * img.height! }))
    const group = imageGroup(meta)
    const preferred = o.config().images[group] ?? DEFAULT_IMAGE[group] ?? 'normal'
    const shown = pickImage({ images: listed } as Pass, preferred)
    const chosen = new Set<PiImage>()
    if (shown) chosen.add(usable[listed.indexOf(shown)])
    const main = usable.find((i) => i.path === meta.main)
    if (main) chosen.add(main)

    const final = path.join(o.downloads, folder)
    const part = path.join(o.downloads, `.${folder}.part`)
    fs.rmSync(part, { recursive: true, force: true })
    fs.mkdirSync(part, { recursive: true })
    try {
      const files: string[] = []
      for (const img of chosen) {
        const res = await get(`/api/passes/${encodeURIComponent(piId)}/large/${img.path.split('/').map(encodeURIComponent).join('/')}`)
        fs.writeFileSync(path.join(part, fileOf(img)), Buffer.from(await res.arrayBuffer()))
        files.push(fileOf(img))
      }
      const samples = (meta.samples ?? []).map((s) => ({
        t: s.t * 1000,
        az: s.az,
        el: s.el,
        snr: s.snr,
        lock: s.deframer_lock === undefined ? undefined : !!s.deframer_lock,
      }))
      if (samples.length) fs.writeFileSync(path.join(part, 'signal.json'), JSON.stringify(samples))
      const orbit = meta.orbit ?? {}
      const start = orbit.aos ?? meta.time
      const end = orbit.los ?? (samples.length ? samples[samples.length - 1].t / 1000 : null)
      // last, as listener.py does: with it the pass is complete
      const observation = {
        id,
        satellite: meta.satellite,
        start: new Date(start * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
        end: end ? new Date(end * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null,
        station_name: meta.station?.name ?? 'raspberry_sat',
        station_lat: meta.station?.lat ?? null,
        station_lng: meta.station?.lon ?? null,
        max_altitude: orbit.max_el ?? null,
        rise_azimuth: orbit.aos_az ?? null,
        set_azimuth: orbit.los_az ?? null,
        transmitter: 'LRPT',
        mode: 'LRPT',
        files,
        receiver: base(),
        receiver_pass: piId,
      }
      fs.writeFileSync(path.join(part, 'observation.json'), JSON.stringify(observation, null, 2))
      fs.renameSync(part, final)
    } catch (e) {
      fs.rmSync(part, { recursive: true, force: true })
      throw e
    }
    status.last = { satellite: meta.satellite, folder, at: Date.now() }
    console.log(`[import] ${folder}: ${chosen.size} image(s) from the receiver`)
    o.onImported(id)
  }

  let again = false
  const check = async () => {
    const r = o.config().receiver
    if (!r.enabled || !r.importPasses) return
    if (busy) {
      again = true // asked while looking: once more after, the pass may not have been in its list
      return
    }
    busy = true
    try {
      const list = (await (await get('/api/passes')).json()) as { passes?: { id: string; time: number; satellite: string; image_count?: number }[] }
      const now = Date.now() / 1000
      let error: string | null = null
      for (const p of list.passes ?? []) {
        if (now - p.time > RECENT_S || !p.image_count) continue
        if (Date.now() - (failed.get(p.id) ?? 0) < RETRY_AFTER) continue
        const folder = folderFor(p.time, p.satellite)
        if (fs.existsSync(path.join(o.downloads, folder))) continue // done already
        try {
          await importPass(p.id, folder, Math.round(p.time))
          failed.delete(p.id)
        } catch (e) {
          failed.set(p.id, Date.now())
          error = `${p.id}: ${(e as Error).message ?? e}`
          console.error(`[import] ${error}`)
        }
      }
      status.error = error
    } catch (e) {
      status.error = (e as Error).message ?? String(e)
    } finally {
      busy = false
      if (again) {
        again = false
        void check()
      }
    }
  }

  setInterval(() => void check(), CHECK_EVERY)
  return { status: () => status, check }
}
