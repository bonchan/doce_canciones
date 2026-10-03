// Synthetic NOAA pass over a station. The recordings were made at stations in other
// places, so instead of propagating a TLE we build a circular sun-synchronous orbit whose
// ground track culminates over the station at the observation's max elevation, in the
// observation's direction (north/southbound, east/west of the station).

import type { Pass } from './shared/types.ts'

const D2R = Math.PI / 180
const R = 6371 // km, spherical earth
const H = 850 // km, NOAA POES altitude
const A = R + H
const MU = 398600.4418
const INC = 98.7 * D2R
const EARTH_ROT = 7.2921159e-5 // rad/s

export const PERIOD = 2 * Math.PI * Math.sqrt(A ** 3 / MU) // ~101.6 min
const RATE = (2 * Math.PI) / PERIOD
// ground distance from the station to where a satellite at H rises above the horizon
export const HORIZON_RADIUS_KM = R * Math.acos(R / A)

export interface Station {
  name: string
  lat: number // degrees
  lon: number
}

export interface GeoPoint {
  lat: number // radians
  lon: number
  alt: number // km
}

export interface Look {
  elevation: number // degrees
  azimuth: number
  range: number // km
}

export interface PassGeometry {
  geo: (t: number) => GeoPoint
  look: (t: number) => Look
  tAos: number // seconds from culmination
  tLos: number
  northbound: boolean
  period: number
}

export const NEUQUEN: Station = { name: 'Neuquén', lat: -38.9516, lon: -68.0591 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

// great-circle destination, all radians
function destination(lat: number, lon: number, bearing: number, dist: number): [number, number] {
  // clamped: rounding can push the sine a hair past 1, and asin(1.0000000000000002) is NaN
  const lat2 = Math.asin(clamp(Math.sin(lat) * Math.cos(dist) + Math.cos(lat) * Math.sin(dist) * Math.cos(bearing), -1, 1))
  const lon2 =
    lon +
    Math.atan2(Math.sin(bearing) * Math.sin(dist) * Math.cos(lat), Math.cos(dist) - Math.sin(lat) * Math.sin(lat2))
  return [lat2, lon2]
}

type Vec3 = [number, number, number]

const ecef = (lat: number, lon: number, r: number): Vec3 => [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// azimuth halfway between rise and set along the shorter arc (degrees)
function midAzimuth(rise: number, set: number) {
  const diff = ((set - rise + 540) % 360) - 180
  return rise + diff / 2
}

export function buildPass(obs: Pass, station: Station = NEUQUEN): PassGeometry {
  const phi = station.lat * D2R
  const lam = station.lon * D2R
  const elevMax = clamp(obs.max_altitude ?? 60, 5, 89.5) * D2R
  const culminationAngle = Math.acos((R * Math.cos(elevMax)) / A) - elevMax

  const northbound = obs.rise_azimuth == null ? obs.id % 2 === 0 : obs.rise_azimuth > 90 && obs.rise_azimuth < 270
  const b = Math.asin(clamp(Math.cos(INC) / Math.cos(phi), -1, 1))
  const heading = northbound ? b : Math.PI - b

  let side = heading + Math.PI / 2
  if (obs.rise_azimuth != null && obs.set_azimuth != null) {
    const mid = midAzimuth(obs.rise_azimuth, obs.set_azimuth) * D2R
    if (angDiff(heading - Math.PI / 2, mid) < angDiff(side, mid)) side = heading - Math.PI / 2
  }
  const [cLat, cLon] = destination(phi, lam, side, culminationAngle)

  // t = seconds from culmination
  const geo = (t: number): GeoPoint => {
    const [lat, lon] = destination(cLat, cLon, heading, RATE * t)
    return { lat, lon: lon - EARTH_ROT * t, alt: H }
  }

  const S = ecef(phi, lam, R)
  const up: Vec3 = [S[0] / R, S[1] / R, S[2] / R]
  const east: Vec3 = [-Math.sin(lam), Math.cos(lam), 0]
  const north: Vec3 = [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)]
  const look = (t: number): Look => {
    const g = geo(t)
    const P = ecef(g.lat, g.lon, A)
    const d: Vec3 = [P[0] - S[0], P[1] - S[1], P[2] - S[2]]
    const range = Math.sqrt(dot(d, d))
    const az = (Math.atan2(dot(d, east), dot(d, north)) / D2R + 360) % 360
    return { elevation: Math.asin(clamp(dot(d, up) / range, -1, 1)) / D2R, azimuth: az, range }
  }

  let tAos = 0
  while (look(tAos).elevation > 0 && tAos > -1800) tAos -= 1
  let tLos = 0
  while (look(tLos).elevation > 0 && tLos < 1800) tLos += 1

  return { geo, look, tAos, tLos, northbound, period: PERIOD }
}
