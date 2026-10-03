// WebSocket messages between server/index.ts and the displays
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
}

// everything the control page can change live (saved back to installation.json)
export interface Settings extends SharedConfig {
  order: 'shuffle' | 'chronological'
  satellites: string[] // only these; empty = all
  waitSeconds: number // between passes, "next pass in ..."
  approachSeconds: number // fast-forward from 15 min before AOS
  departSeconds: number
  upcoming: number // passes scheduled ahead
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
}

export interface StateMessage {
  type: 'state'
  now: number
  slots: Slot[] // on air first, then the upcoming ones
  history: Slot[] // most recent first
  config: Settings
  library: LibraryInfo
}

export type ServerMessage =
  | StateMessage
  | { type: 'pong'; t0: number; server: number }
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'library'; passes: PassSummary[] }
  | { type: 'command'; action: 'reload' | 'identify' }

export type ControlAction = 'skip' | 'restart' | 'identify' | 'reload'

export type ClientMessage =
  | { type: 'hello'; id: string; view: string; audio: boolean }
  | { type: 'ping'; t0: number }
  | { type: 'control'; action: ControlAction }
  | { type: 'queue'; passId: number }
  | { type: 'library' }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'error'; message: string }
