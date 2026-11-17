// The look-up moment's settings (src/components/Cenit.tsx): at the top of a pass with a sky
// photo every screen but the globes shows the photo plain, full screen, then lets it go.
// Shared by the server (installation.json, checking changes) and the displays. No DOM here.

export interface CenitSettings {
  on: boolean // the moment at all (a test still shows)
  fadeIn: number // s
  hold: number // s at its fullest, centred on the top of the pass
  fadeOut: number // s
  opacity: number // %: at its fullest; 100 hides the view under it
  zoom: number // %: each display's window into the photo; 100 the whole photo, more is closer
  drift: number // %: how far it drifts with the wind while it's up (and the slow zoom out with it)
  minPass: number // s: passes that go by faster than this (high speeds) don't stop to look
}

export const CENIT_DEFAULTS: CenitSettings = {
  on: true,
  fadeIn: 1.8,
  hold: 5.5,
  fadeOut: 2.6,
  opacity: 100,
  zoom: 135,
  drift: 3,
  minPass: 25,
}

export const CENIT_RANGES: Record<Exclude<keyof CenitSettings, 'on'>, [number, number]> = {
  fadeIn: [0, 30],
  hold: [0, 120],
  fadeOut: [0, 30],
  opacity: [0, 100],
  zoom: [100, 300],
  drift: [0, 20],
  minPass: [0, 600],
}

// `patch` (any of the fields; unknown values dropped, numbers clamped) over `current`
export function cleanCenit(patch: unknown, current: CenitSettings = CENIT_DEFAULTS): CenitSettings {
  const out = { ...CENIT_DEFAULTS, ...current }
  if (!patch || typeof patch !== 'object') return out
  const p = patch as Record<string, unknown>
  if (typeof p.on === 'boolean') out.on = p.on
  for (const [key, [min, max]] of Object.entries(CENIT_RANGES) as [keyof typeof CENIT_RANGES, [number, number]][]) {
    const v = p[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v))
  }
  return out
}
