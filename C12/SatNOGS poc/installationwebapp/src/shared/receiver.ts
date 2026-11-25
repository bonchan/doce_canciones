// The real passes' settings (server/receiver.ts): the real receiver, raspberry_sat on a Raspberry
// Pi, whose passes go live on the timeline. Live: a change applies right away. No DOM here.

export interface ReceiverSettings {
  enabled: boolean // follow the real receiver
  url: string // its web page, e.g. http://rpi4b.local:8000
  minElevation: number // degrees: only its passes that climb at least this high go live
  joinDelay: number // s after AOS the screens switch to it (0: right at AOS)
  importPasses: boolean // a finished pass goes into downloads/, the library (server/importer.ts)
  playImported: boolean // ... and plays right after the slot on air
}

export const RECEIVER_DEFAULTS: ReceiverSettings = {
  enabled: false,
  url: 'http://rpi4b.local:8000',
  minElevation: 0,
  joinDelay: 0,
  importPasses: true,
  playImported: true,
}

export const RECEIVER_RANGES = {
  minElevation: [0, 90],
  joinDelay: [0, 600],
} satisfies Record<string, [number, number]>

// `patch` (any of the fields; unknown values dropped, numbers clamped) over `current`
export function cleanReceiver(patch: unknown, current: ReceiverSettings = RECEIVER_DEFAULTS): ReceiverSettings {
  const out = { ...RECEIVER_DEFAULTS, ...current }
  if (!patch || typeof patch !== 'object') return out
  const p = patch as Record<string, unknown>
  if (typeof p.enabled === 'boolean') out.enabled = p.enabled
  if (typeof p.importPasses === 'boolean') out.importPasses = p.importPasses
  if (typeof p.playImported === 'boolean') out.playImported = p.playImported
  if (typeof p.url === 'string' && /^https?:\/\/\S+$/.test(p.url.trim())) out.url = p.url.trim().replace(/\/+$/, '')
  for (const [key, [min, max]] of Object.entries(RECEIVER_RANGES) as [keyof typeof RECEIVER_RANGES, [number, number]][]) {
    const v = p[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v))
  }
  return out
}
