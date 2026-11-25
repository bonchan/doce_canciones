// The real receiver: raspberry_sat on a Raspberry Pi (SatDump, Meteor LRPT), by its own HTTP API.
// Its upcoming passes, the ones it will record, become live slots on the shared timeline
// (conductor.ts); while one is near or on air, its reading (where the satellite is in the sky, the
// signal, the decoder's lock, the data so far) is read once a second and handed on (index.ts sends
// it to every display). After LOS, while the Pi decodes the pass, how far it is (its WebSocket
// topic "processing") and when it's done (its finished passes). Only the server talks to the Pi:
// one client, however many displays.
import { WebSocket } from 'ws'
import type { LiveReading, LiveSample } from '../src/shared/protocol.ts'
import type { ReceiverSettings } from '../src/shared/receiver.ts'
import type { Pass, StationInfo } from '../src/shared/types.ts'

const SCHEDULE_EVERY = 60_000 // its predictions change slowly (it re-works them every 5 min)
const STATION_EVERY = 10 * 60_000
const LIVE_EVERY = 1000
const SPECTRUM_EVERY = 250 // what the Pi's own Live page gets
const TIMEOUT = 5000
// it has stopped answering: this many requests in a row unanswered, the last answer this long ago
// (a minute apart when no live pass is near: 3 min; a second apart near one: some 20 s)
const SILENT_AFTER = 3
const SILENT_MS = 20_000

interface ReceiverOptions {
  settings: () => ReceiverSettings // read every time: on / off and the address change live
  // The upcoming passes it will record, when they change. While it doesn't answer (switched off,
  // the network down) none: the installation goes on with its replays, a live pass on air
  // included (silent); they come back when it answers again.
  onPasses: (passes: Pass[], silent?: boolean) => void
  wanted: () => boolean // a live slot is near or on air: read the live reading
  receiving: () => boolean // a live slot is between AOS and LOS: read the spectrum too
  onReading: (reading: LiveReading | null, samples: LiveSample[], reset: boolean) => void
  onSpectrum: (t: number, bins: Uint8Array, frequency: number | null, samplerate: number | null) => void
  processingWanted: () => boolean // a live pass is past LOS and the Pi isn't done with it
  onProcessing: (work: PiWork | null) => void // how far it is (null: working on none)
  onFinished: (passes: { time: number; images: number }[]) => void // its finished passes (time: unix s)
}

// what the Pi is working on after LOS (raspberry_sat's processing.py)
export interface PiWork {
  pass: string // its folder
  satellite: string | null
  step: 'decode' | 'images' | 'thumbnails'
  percent: number | null // 0-100, null when there's nothing to go by
}

interface PiSample {
  t: number // unix seconds
  az?: number | null
  el?: number | null
  snr?: number
  deframer_lock?: boolean | number
}

const sample = (s: PiSample): LiveSample => ({
  t: s.t * 1000,
  az: s.az,
  el: s.el,
  snr: s.snr,
  lock: s.deframer_lock === undefined ? undefined : !!s.deframer_lock,
})

// what /api/schedule gives per pass (orbits.py describe_pass, plus the satellite)
interface SchedulePass {
  aos: number // unix seconds
  los: number
  tca?: number
  max_el: number
  aos_az?: number
  los_az?: number
  name: string
  norad?: number
  scheduled?: boolean // high enough for SatDump to record
}

// how it's doing, for the operator pages
export interface ReceiverStatus {
  ok: boolean | null // null: not asked yet (or off)
  error: string | null
  passes: Pass[] // its upcoming passes it will record
}

export function startReceiver(o: ReceiverOptions) {
  const base = () => o.settings().url.replace(/\/+$/, '')
  const on = () => o.settings().enabled
  let station: StationInfo | null = null
  let lastPasses = ''
  let lastBase = ''
  const failing = new Set<string>()
  const status: ReceiverStatus = { ok: null, error: null, passes: [] }
  let lastAnswer = 0 // when it last answered, ms (0: not yet)
  let unanswered = 0 // requests in a row it didn't answer
  let answering = false // as the timeline knows it

  const get = async <T,>(path: string): Promise<T> => {
    const res = await fetch(base() + path, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  }

  // it went quiet: its passes leave the timeline; it's back: the last ones it gave come back
  const heard = () => {
    const now = lastAnswer > 0 && (unanswered < SILENT_AFTER || Date.now() - lastAnswer < SILENT_MS)
    if (now === answering) return
    answering = now
    if (now) {
      console.log(`[receiver] ${base()} is answering`)
      o.onPasses(status.passes)
      lastPasses = JSON.stringify(status.passes.map((p) => [p.id, p.start, p.end, p.satellite, p.station?.lat]))
    } else {
      console.error(`[receiver] ${base()} is not answering: its passes leave the timeline until it does`)
      o.onPasses([], true)
      lastPasses = ''
    }
  }

  // logged once until it works again, not every second
  const attempt = async (what: string, job: () => Promise<void>) => {
    try {
      await job()
      lastAnswer = Date.now()
      unanswered = 0
      if (failing.delete(what)) console.log(`[receiver] ${what}: answering again`)
      if (!failing.size) Object.assign(status, { ok: true, error: null })
    } catch (e) {
      unanswered++
      const message = (e as Error).message ?? String(e)
      if (!failing.has(what)) console.error(`[receiver] ${what} from ${base()}: ${message}`)
      failing.add(what)
      Object.assign(status, { ok: false, error: `${what}: ${message}` })
    }
    heard()
  }

  const toPass = (p: SchedulePass): Pass => ({
    id: -Math.round(p.aos), // negative: never a library pass's id
    folder: '',
    satellite: p.name,
    norad_cat_id: p.norad ?? null,
    mode: 'LRPT',
    start: new Date(p.aos * 1000).toISOString(),
    end: new Date(p.los * 1000).toISOString(),
    max_altitude: p.max_el,
    rise_azimuth: p.aos_az ?? null,
    set_azimuth: p.los_az ?? null,
    station_id: null,
    station_name: station?.name ?? 'raspberry_sat',
    station,
    url: null,
    images: [],
    audio: null,
    audio_seconds: null,
    live: true,
  })

  const readStation = () =>
    on() &&
    attempt('station', async () => {
      const t = await get<{ station?: { name?: string; lat: number; lon: number } }>('/api/tles')
      if (t.station) station = { name: t.station.name || 'raspberry_sat', lat: t.station.lat, lon: t.station.lon }
    })

  const readSchedule = async () => {
    // switched off, or another address: start over
    if (!on() || base() !== lastBase) {
      if (lastPasses !== '') o.onPasses([])
      lastPasses = ''
      status.passes = []
      failing.clear()
      Object.assign(status, { ok: null, error: null })
      lastAnswer = 0
      unanswered = 0
      answering = false
      if (!on()) return
      lastBase = base()
      station = null
      await readStation()
    }
    await attempt('schedule', async () => {
      const s = await get<{ passes?: SchedulePass[] }>('/api/schedule?tracks=false')
      const passes = (s.passes ?? []).filter((p) => p.scheduled !== false).map(toPass)
      const key = JSON.stringify(passes.map((p) => [p.id, p.start, p.end, p.satellite, p.station?.lat]))
      status.passes = passes
      // (not answering till now: heard() hands them on, right after this)
      if (key === lastPasses || !answering) return
      lastPasses = key
      o.onPasses(passes)
    })
  }

  // the latest reading, and the pass's samples newer than the last ones (all of them for a new pass)
  let reading = false
  let after = 0 // the last sample's time, unix seconds
  let passStarted = -1
  let resetNext = false
  const readLive = async () => {
    if (!on() || !o.wanted()) {
      if (reading) o.onReading(null, [], false)
      reading = false
      return
    }
    reading = true
    await attempt('live', async () => {
      const live = await get<{
        receiving: boolean
        pass_started?: number
        history?: PiSample[]
        current: (Omit<LiveReading, 't' | 'receiving' | 'bytes'> & { t: number }) | null
        cadu_bytes?: number
      }>(`/api/live?after=${after}`)
      let reset = resetNext
      resetNext = false
      if (live.pass_started !== passStarted) {
        // another pass: from its start
        passStarted = live.pass_started ?? 0
        reset = true
        if (after > 0) {
          after = 0
          resetNext = true
          return // its whole history comes with the next read
        }
      }
      const history = live.history ?? []
      if (history.length) after = Math.max(after, ...history.map((s) => s.t))
      const c = live.current
      o.onReading(
        { ...(c ?? {}), t: c ? c.t * 1000 : Date.now(), receiving: !!live.receiving, bytes: live.cadu_bytes ?? 0 },
        history.map(sample),
        reset,
      )
    })
  }

  // the spectrum while receiving: SatDump only works it out while someone asks
  const readSpectrum = async () => {
    if (!on() || !o.receiving()) return
    await attempt('spectrum', async () => {
      const s = await get<{
        db: (number | null)[]
        min: number
        max: number
        frequency?: number | null
        samplerate?: number | null
        time?: number
      }>('/api/spectrum')
      // a column where the Pi couldn't find the trace in SatDump's picture comes as null: the
      // nearest one before it that has it (the first that has it at the start; the floor if none)
      const first = s.db.find((v) => typeof v === 'number') ?? s.min
      let held = first
      const db = s.db.map((v) => (typeof v === 'number' ? (held = v) : held))
      const span = s.max - s.min || 1
      const bins = Uint8Array.from(db, (v) => Math.round(255 * Math.min(1, Math.max(0, (v - s.min) / span))))
      o.onSpectrum(s.time ? s.time * 1000 : Date.now(), bins, s.frequency ?? null, s.samplerate ?? null)
    })
  }

  // After LOS, while index.ts asks (a live pass still being decoded): how far the Pi is with it,
  // from its WebSocket topic "processing" (raspberry_sat's processing.py: only there), and its
  // finished passes (GET /api/passes lists a pass once it's done, with its images), every 30 s and
  // right after the Pi says it's done.
  let socket: WebSocket | null = null
  let socketBase = ''
  let socketRetry = 0
  let working = false // the Pi said it's working on a pass
  let finishedRead = 0
  const closeSocket = () => {
    socket?.close()
    socket = null
  }
  const openSocket = () => {
    if (socket && socketBase === base()) return
    closeSocket()
    if (Date.now() < socketRetry) return
    const url = base().replace(/^http/, 'ws') + '/api/ws'
    const s = new WebSocket(url, { handshakeTimeout: TIMEOUT })
    socket = s
    socketBase = base()
    s.on('open', () => {
      failing.delete('processing')
      s.send(JSON.stringify({ subscribe: ['processing'] })) // its snapshot comes straight back
    })
    s.on('message', (raw) => {
      let m: { topic?: string; data?: PiWork | null }
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.topic !== 'processing') return
      const work = m.data ?? null
      if (working && !work) finishedRead = 0 // done: its finished passes now
      working = !!work
      o.onProcessing(work)
    })
    const gone = () => {
      if (socket !== s) return
      socket = null
      socketRetry = Date.now() + 10_000
    }
    s.on('close', gone)
    s.on('error', (e) => {
      if (!failing.has('processing')) console.error(`[receiver] processing from ${url}: ${e.message}`)
      failing.add('processing')
      gone()
    })
  }
  const watchProcessing = async () => {
    if (!on() || !answering || !o.processingWanted()) {
      if (socket) closeSocket()
      working = false
      failing.delete('processing')
      return
    }
    openSocket()
    if (Date.now() - finishedRead < 30_000) return
    finishedRead = Date.now()
    await attempt('passes', async () => {
      const r = await get<{ passes?: { time: number; image_count?: number }[] }>('/api/passes')
      o.onFinished((r.passes ?? []).map((p) => ({ time: p.time, images: p.image_count ?? 0 })))
    })
  }

  // one after the other, never two of a kind at once (a slow Pi doesn't pile them up); a bug in one
  // is logged and it goes on, instead of taking the server down
  const loop = (job: () => Promise<void>, every: number) => {
    const run = async () => {
      try {
        await job()
      } catch (e) {
        console.error('[receiver]', e)
      }
      setTimeout(run, every)
    }
    void run()
  }
  // the schedule every minute, and right away after a change of the settings (check)
  let timer: NodeJS.Timeout | undefined
  const schedule = async () => {
    clearTimeout(timer)
    try {
      await readSchedule()
    } catch (e) {
      console.error('[receiver]', e)
    }
    timer = setTimeout(schedule, SCHEDULE_EVERY)
  }
  void schedule()
  loop(readLive, LIVE_EVERY)
  loop(readSpectrum, SPECTRUM_EVERY)
  loop(watchProcessing, 2000)
  setInterval(readStation, STATION_EVERY)
  return {
    status: () => status,
    // the settings changed: if it's switched on or off, or moved, look again now
    check: () => {
      if (on() !== (lastBase !== '') || (on() && base() !== lastBase)) {
        if (!on()) lastBase = ''
        void schedule()
      }
    },
  }
}
