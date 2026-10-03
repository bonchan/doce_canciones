import type { Pass, PassImage } from './shared/types.ts'

const LABELS: Record<string, string> = {
  normal: 'Normal',
  decoded: 'Decoded',
  mcir: 'MCIR',
  'mcir-precip': 'MCIR precip',
  msa: 'MSA',
  msa_ch1: 'MSA ch1',
  hvc: 'HVC',
  'hvc-precip': 'HVC precip',
  class: 'Class',
}

// preferred image per satellite family until one is picked by hand
export const DEFAULT_IMAGE: Record<string, string> = {
  NOAA: 'normal',
  METEOR: 'mcir_map',
}

// listing order: known kinds first, then whatever the station uploaded
const ORDER = ['normal', 'decoded', 'mcir', 'msa', 'avhrr', 'hvc', 'class', 'vis']

export const kindLabel = (img: PassImage) => LABELS[img.kind] ?? img.label

// "NOAA-15" -> "NOAA", "METEOR-M2-3" -> "METEOR"
export const imageGroup = (pass: { satellite: string }) => pass.satellite.split('-')[0].toUpperCase()

const tokens = (kind: string) => kind.split(/[-_ ]+/)

const rank = (kind: string) => {
  const i = ORDER.indexOf(tokens(kind)[0])
  return i < 0 ? ORDER.length : i
}

export function sortedImages(pass: Pass | null): PassImage[] {
  return [...(pass?.images ?? [])].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
}

// exact kind, else the closest one ("mcir_map" -> "mcir_corrected_map" -> "mcir"), else the first listed.
// Ties go to the bigger file: some stations upload near-empty products
export function pickImage(pass: Pass | null, preferred: string): PassImage | null {
  const imgs = sortedImages(pass)
  const exact = imgs.find((i) => i.kind === preferred)
  if (exact) return exact
  const want = tokens(preferred)
  const score = (kind: string) => {
    const [head, ...rest] = tokens(kind)
    return (head === want[0] ? 2 : 0) + rest.filter((t) => want.includes(t)).length
  }
  let best = imgs[0] ?? null
  let bestScore = 0
  for (const img of imgs) {
    const s = score(img.kind)
    if (s > bestScore || (s > 0 && s === bestScore && best && img.bytes > best.bytes)) {
      best = img
      bestScore = s
    }
  }
  return best
}
