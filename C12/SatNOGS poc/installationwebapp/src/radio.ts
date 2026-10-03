import type { PassGeometry } from './orbit.ts'

// nominal downlinks (MHz)
const DOWNLINK_MHZ: Record<string, number> = {
  'NOAA-15': 137.62,
  'NOAA-18': 137.9125,
  'NOAA-19': 137.1,
  'METEOR-M2-3': 137.9,
  'METEOR-M2-4': 137.9,
}

const C_KM_S = 299792.458

export const downlinkMHz = (satellite: string) => DOWNLINK_MHZ[satellite] ?? 137.5

// km/s, positive = moving away (orbit seconds)
export const rangeRate = (g: PassGeometry, t: number) => (g.look(t + 1).range - g.look(t - 1).range) / 2

export const dopplerHz = (mhz: number, rangeRateKmS: number) => (-mhz * 1e6 * rangeRateKmS) / C_KM_S

// free-space path loss
export const pathLossDb = (km: number, mhz: number) => 20 * Math.log10(km) + 20 * Math.log10(mhz) + 32.44
