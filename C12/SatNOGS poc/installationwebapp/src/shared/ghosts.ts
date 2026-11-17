// The reception ghosts' settings (src/components/Ghosts.tsx), each kind on its own: when it
// appears, how often and how strongly. Shared by the server (installation.json, checking
// changes) and the displays. No DOM here.

export const GHOST_KINDS = ['tear', 'echo', 'roll', 'blocks', 'smear', 'mosaic'] as const
export type GhostKind = (typeof GHOST_KINDS)[number]

// the analog ones break up NOAA passes (APT), the digital ones METEOR passes (LRPT)
export const GHOST_FAMILY: Record<GhostKind, 'NOAA' | 'METEOR'> = {
  tear: 'NOAA', // lines torn sideways, colours split
  echo: 'NOAA', // a faint copy of the picture, a little to the right
  roll: 'NOAA', // the frame rolls, a black bar between frames
  blocks: 'METEOR', // runs of 8 x 8 blocks from the wrong place
  smear: 'METEOR', // a row of blocks, its last line dragged down
  mosaic: 'METEOR', // the photo surfacing in scattered blocks
}

// when it appears:
//   low     the more the lower the satellite (weak signal: around AOS and LOS); with it
//           overhead an eighth as often
//   high    the other way round: the more the higher the satellite
//   steady  the same all pass long
//   off     never
export const GHOST_APPEAR = ['low', 'high', 'steady', 'off'] as const
export type GhostAppear = (typeof GHOST_APPEAR)[number]

export interface GhostSettings {
  appear: GhostAppear
  delay: number // seconds between two, on average (low / high: where there are most of them)
  prominence: number // %: 100 as designed, 0 not there, 200 twice as big, many and strong
}

export type GhostsSettings = Record<GhostKind, GhostSettings>

export const GHOST_DEFAULTS: GhostsSettings = {
  tear: { appear: 'low', delay: 4, prominence: 100 },
  echo: { appear: 'low', delay: 10, prominence: 100 },
  roll: { appear: 'low', delay: 16, prominence: 100 },
  blocks: { appear: 'low', delay: 5, prominence: 100 },
  smear: { appear: 'low', delay: 10, prominence: 100 },
  mosaic: { appear: 'low', delay: 10, prominence: 100 },
}

export const GHOST_DELAY: [number, number] = [0.5, 600]
export const GHOST_PROMINENCE: [number, number] = [0, 500]

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v))

// `patch` (any kinds, any of their fields; unknown values dropped, numbers clamped) over `current`
export function cleanGhosts(patch: unknown, current: GhostsSettings = GHOST_DEFAULTS): GhostsSettings {
  const out = { ...current }
  if (!patch || typeof patch !== 'object') return out
  for (const kind of GHOST_KINDS) {
    const p = (patch as Record<string, unknown>)[kind]
    if (!p || typeof p !== 'object') continue
    const { appear, delay, prominence } = p as Record<string, unknown>
    const next = { ...GHOST_DEFAULTS[kind], ...out[kind] }
    if (GHOST_APPEAR.includes(appear as GhostAppear)) next.appear = appear as GhostAppear
    if (typeof delay === 'number' && Number.isFinite(delay)) next.delay = clamp(delay, GHOST_DELAY)
    if (typeof prominence === 'number' && Number.isFinite(prominence)) next.prominence = clamp(prominence, GHOST_PROMINENCE)
    out[kind] = next
  }
  return out
}
