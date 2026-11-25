// WebSocket messages between server/index.ts and the displays
import type { CenitSettings } from './cenit.ts'
import type { GhostKind, GhostsSettings } from './ghosts.ts'
import type { ReceiverSettings } from './receiver.ts'
import type { Pass } from './types.ts'

// the part of installation.json every display needs
export interface SharedConfig {
  location: 'station' | 'neuquen' // pass over its recording station, or always over Neuquén
  imagery: 'esri' | 'natural'
  speed: number // 1 = real time
  volume: number
  images: Record<string, string> // preferred image kind per satellite family: { NOAA: 'normal', METEOR: 'mcir_map' }
  hideCursor: boolean // displays hide the mouse pointer
  language: string // displays' language: a file in src/lang (en, es)
  phrases: boolean // reception: a generated phrase arrives inside the image
  sky: number // % of the passes with a sky photo (../sky_images): 0 none, 100 all (src/art/sky.ts)
  ghostsOn: boolean // the ghosts at all; off keeps each kind's settings
  ghosts: GhostsSettings // the sky photo breaking into the signal, per kind (src/shared/ghosts.ts)
  cenit: CenitSettings // the plain sky photo at the top of the pass (src/shared/cenit.ts)
}

// everything the control page can change live (saved back to installation.json)
export interface Settings extends SharedConfig {
  order: 'shuffle' | 'chronological'
  satellites: string[] // only these; empty = all
  waitSeconds: number // between passes, "next pass in ..."
  approachSeconds: number // fast-forward from 15 min before AOS
  departSeconds: number
  upcoming: number // passes scheduled ahead
  receiver: ReceiverSettings // the real passes (src/shared/receiver.ts)
}

// One pass on the shared timeline. Times are the server's clock (epoch ms): every display
// draws "now" from these, so they all show the same moment of the same pass.
export interface Slot {
  id: number
  pass: Pass
  start: number // waiting for the satellite
  approachAt: number // fast-forward to AOS
  aos: number // reception: sound and image
  los: number
  end: number // satellite gone; the next slot starts here
}

export interface LibraryInfo {
  passes: number
  stations: number
  satellites: Record<string, number>
}

export interface PassSummary {
  id: number
  satellite: string
  station_name: string | null
  start: string
  max_altitude: number | null
  audio: boolean
  kinds: string[] // its image kinds
}

export interface DisplayInfo {
  id: string
  view: string
  audio: boolean
  address: string
  since: number
  errors: number // reported since it connected
  lastError: string | null
  fps: number | null // frames it drew per second, from its last health report
  visible: boolean | null // its page is on screen (not hidden or minimized)
  health: number | null // when that report came in (server time, ms)
}

export interface StateMessage {
  type: 'state'
  now: number
  slots: Slot[] // on air first, then the upcoming ones
  history: Slot[] // most recent first
  config: Settings
  library: LibraryInfo
  sky: string[] // the sky photos' file names (served at /sky/<name>)
  // the real receiver's next passes that go live, soonest first (none while it's off or doesn't
  // answer): the passes board shows the next one
  real?: Pass[]
}

// a test of the ghosts, from the operator page or core2: these kinds, on every display at `at`
// (server time, a moment after it was asked for, so they all start together), at their prominence
export interface GhostTest {
  kinds: GhostKind[]
  at: number
  seed: number
}

// a test of the look-up moment (components/Cenit.tsx): on every display at `at` (server time)
export interface CenitTest {
  at: number
}

// A live pass after LOS (the passes board): the Pi decoding it, how far (its step, and percent when
// it can tell; 'import': done, its images coming over), then received (pass: the imported pass,
// on next) or finished without an image (shown as such till `until`: the pass on air then ends)
export type AfterLos =
  | { state: 'processing'; step: 'decode' | 'images' | 'thumbnails' | 'import' | null; percent: number | null }
  | { state: 'received'; pass: number | null }
  | { state: 'empty'; until: number }

// the real receiver's latest reading during a live pass (server/receiver.ts, from raspberry_sat)
export interface LiveReading {
  t: number // when it was read, ms
  receiving: boolean // SatDump is recording and decoding
  az?: number | null // where the satellite is, degrees
  el?: number | null
  snr?: number // dB
  peak_snr?: number
  freq?: number
  viterbi_ber?: number
  viterbi_lock?: boolean | number
  deframer_lock?: boolean | number // the decoder is getting frames
  rs_avg?: number
  bytes: number // data received so far
}

// one second of a live pass, as the receiver keeps them (raspberry_sat's history)
export interface LiveSample {
  t: number // ms
  az?: number | null
  el?: number | null
  snr?: number
  lock?: boolean // the decoder had frames (deframer lock)
}

export type ServerMessage =
  | StateMessage
  | { type: 'pong'; t0: number; server: number }
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'library'; passes: PassSummary[] }
  | { type: 'command'; action: 'reload' | 'identify'; ids?: string[] } // ids: only those displays
  | ({ type: 'ghost' } & GhostTest)
  | ({ type: 'cenit' } & CenitTest)
  // once a second while a live slot is near or on: the latest reading and the samples since the
  // last message (reset: these are all of the pass's, from the start)
  | { type: 'live'; reading: LiveReading | null; samples: LiveSample[]; reset: boolean }
  // the receiver's spectrum, 4 a second during a live pass: 0..255 per bin, base64, the tuned
  // frequency in the middle
  | { type: 'spectrum'; t: number; bins: string; frequency: number | null; samplerate: number | null }
  // the live passes past LOS, by pass id, when one changes (and on connecting)
  | { type: 'afterlos'; passes: Record<number, AfterLos> }

export type ControlAction = 'skip' | 'restart' | 'identify' | 'reload'

export type ClientMessage =
  | { type: 'hello'; id: string; view: string; audio: boolean }
  | { type: 'ping'; t0: number }
  | { type: 'control'; action: ControlAction }
  | { type: 'queue'; passId: number }
  | { type: 'library' }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'ghost'; kinds: GhostKind[] } // test these ghosts now
  | { type: 'cenit' } // test the look-up moment now
  | { type: 'error'; message: string }
  | { type: 'health'; fps: number; visible: boolean } // every few seconds from each display
