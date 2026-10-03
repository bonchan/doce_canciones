// Where a slot is at a given (server) time: phase, reception progress, satellite position
import { NEUQUEN, buildPass, type PassGeometry, type Station } from './orbit.ts'
import type { SharedConfig, Slot, StateMessage } from './shared/protocol.ts'
import type { Pass } from './shared/types.ts'

export const APPROACH_SIM = 900 // orbit seconds fast-forwarded before AOS
const DEPART_SIM = 600

export type Phase = 'waiting' | 'approach' | 'pass' | 'depart'

// NaN-safe: a zero-length phase (0/0) counts as not started
const clamp01 = (v: number) => (v > 0 ? Math.min(1, v) : 0)

// the slot on air at t (the first one that hasn't ended)
export function activeSlot(state: StateMessage | null, t: number): Slot | null {
  return state?.slots.find((s) => t < s.end) ?? null
}

export function phaseAt(s: Slot, t: number): Phase {
  if (t < s.approachAt) return 'waiting'
  if (t < s.aos) return 'approach'
  if (t < s.los) return 'pass'
  return 'depart'
}

export const progressAt = (s: Slot, t: number) => clamp01((t - s.aos) / (s.los - s.aos))

export function stationFor(pass: Pass, config: SharedConfig): Station {
  return config.location === 'station' && pass.station ? pass.station : NEUQUEN
}

const geometries = new Map<string, PassGeometry>()

export function geometryFor(pass: Pass, config: SharedConfig): PassGeometry {
  const station = stationFor(pass, config)
  const key = `${pass.id}|${station.lat}|${station.lon}`
  let g = geometries.get(key)
  if (!g) {
    if (geometries.size > 40) geometries.clear()
    g = buildPass(pass, station)
    geometries.set(key, g)
  }
  return g
}

// orbit time (seconds from culmination) shown at t; never NaN, that would reach Cesium
export function satTimeAt(s: Slot, g: PassGeometry, t: number): number {
  const v = orbitTime(s, g, t)
  return Number.isFinite(v) ? v : g.tAos - APPROACH_SIM
}

function orbitTime(s: Slot, g: PassGeometry, t: number): number {
  switch (phaseAt(s, t)) {
    case 'waiting':
      return g.tAos - APPROACH_SIM
    case 'approach':
      return g.tAos - APPROACH_SIM * (1 - clamp01((t - s.approachAt) / (s.aos - s.approachAt)))
    case 'pass':
      return g.tAos + progressAt(s, t) * (g.tLos - g.tAos)
    case 'depart':
      return g.tLos + DEPART_SIM * clamp01((t - s.los) / (s.end - s.los))
  }
}

// UTC of the original recording at that point of the pass
export const recordingTime = (s: Slot, g: PassGeometry, satT: number) =>
  new Date(Date.parse(s.pass.start) + (satT - g.tAos) * 1000)

export function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export const clock = (t: number, locale?: string) => new Date(t).toLocaleTimeString(locale, { hour12: false })
export const hhmm = (t: number, locale?: string) =>
  new Date(t).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
export const recorded = (pass: Pass) => `${pass.start.slice(0, 16).replace('T', ' ')} UTC`
