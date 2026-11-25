import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CENIT_DEFAULTS, cleanCenit } from '../src/shared/cenit.ts'
import { RECEIVER_DEFAULTS, cleanReceiver } from '../src/shared/receiver.ts'
import { GHOST_DEFAULTS, GHOST_KINDS, cleanGhosts, type GhostKind } from '../src/shared/ghosts.ts'
import type { Settings } from '../src/shared/protocol.ts'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const CONFIG_FILE = path.join(ROOT, 'installation.json')
// the template in git; installation.json itself isn't (it holds the MQTT password)
const EXAMPLE_FILE = path.join(ROOT, 'installation.example.json')

// Settings change live (control page, or saving this file); the rest needs a restart
export interface InstallationConfig extends Settings {
  server: { host: string; port: number }
  downloads: string // listener.py's folder, relative to this project
  skyImages: string // the sky photos' folder (sky.ts), relative to this project
  // this server as a device on core2's MQTT bus (see device.ts)
  mqtt: { enabled: boolean; broker: string; username: string; password: string; zone: string; name: string }
}

const DEFAULTS: InstallationConfig = {
  server: { host: '127.0.0.1', port: 5180 },
  downloads: '../downloads',
  skyImages: '../sky_images',
  location: 'station',
  imagery: 'natural', // offline: bundled with Cesium, no internet
  order: 'shuffle',
  satellites: [],
  speed: 1,
  volume: 0.9,
  images: { NOAA: 'normal', METEOR: 'mcir_map' },
  hideCursor: true,
  language: 'en',
  phrases: true,
  sky: 100,
  ghostsOn: true,
  ghosts: GHOST_DEFAULTS,
  cenit: CENIT_DEFAULTS,
  waitSeconds: 20,
  approachSeconds: 8,
  departSeconds: 6,
  upcoming: 8,
  receiver: RECEIVER_DEFAULTS,
  mqtt: {
    enabled: false,
    broker: 'mqtt://nuc.local:1883',
    username: '',
    password: '',
    zone: 'satnogs',
    name: 'satnogs-installation',
  },
}

const EDITABLE: (keyof Settings)[] = [
  'location',
  'imagery',
  'speed',
  'volume',
  'images',
  'hideCursor',
  'language',
  'phrases',
  'sky',
  'ghostsOn',
  'ghosts',
  'cenit',
  'receiver',
  'order',
  'satellites',
  'waitSeconds',
  'approachSeconds',
  'departSeconds',
  'upcoming',
]

const RANGES: Record<string, [number, number]> = {
  speed: [0.05, 100],
  volume: [0, 1],
  waitSeconds: [0, 3600],
  approachSeconds: [0, 600],
  departSeconds: [0, 600],
  upcoming: [1, 50],
  sky: [0, 100],
}

const CHOICES: Record<string, string[]> = {
  location: ['station', 'neuquen'],
  imagery: ['esri', 'natural'],
  order: ['shuffle', 'chronological'],
}

export function loadConfig(): InstallationConfig {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(EXAMPLE_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE)
    console.log('[settings] created installation.json from installation.example.json')
  }
  const raw = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {}
  return {
    ...DEFAULTS,
    ...raw,
    server: { ...DEFAULTS.server, ...raw.server },
    mqtt: { ...DEFAULTS.mqtt, ...raw.mqtt },
    receiver: cleanReceiver(raw.receiver),
    images: { ...DEFAULTS.images, ...raw.images },
    // a percentage; it used to be on / off
    sky: typeof raw.sky === 'number' ? Math.min(100, Math.max(0, raw.sky)) : raw.sky === false ? 0 : 100,
    // any kinds and fields left out: as designed
    ghosts: cleanGhosts(raw.ghosts),
    cenit: cleanCenit(raw.cenit),
  }
}

export const settingsOf = (c: InstallationConfig) => Object.fromEntries(EDITABLE.map((k) => [k, c[k]])) as unknown as Settings

// what's usable in a settings change from the control page (numbers clamped, unknown values dropped)
export function cleanSettings(patch: Record<string, unknown>, current: InstallationConfig): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = patch[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, key === 'upcoming' ? Math.round(v) : v))
  }
  for (const [key, options] of Object.entries(CHOICES)) {
    if (options.includes(patch[key] as string)) out[key] = patch[key]
  }
  if (typeof patch.hideCursor === 'boolean') out.hideCursor = patch.hideCursor
  if (typeof patch.phrases === 'boolean') out.phrases = patch.phrases
  if (typeof patch.ghostsOn === 'boolean') out.ghostsOn = patch.ghostsOn
  if (typeof patch.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(patch.language)) out.language = patch.language
  if (Array.isArray(patch.satellites) && patch.satellites.every((s) => typeof s === 'string')) out.satellites = patch.satellites
  // e.g. {"tear": {"delay": 6}}: only what's in it changes
  if (patch.ghosts && typeof patch.ghosts === 'object') out.ghosts = cleanGhosts(patch.ghosts, current.ghosts)
  // e.g. {"enabled": false} or {"joinDelay": 30}: only what's in it changes
  if (patch.receiver && typeof patch.receiver === 'object') out.receiver = cleanReceiver(patch.receiver, current.receiver)
  // e.g. {"hold": 8}: only what's in it changes
  if (patch.cenit && typeof patch.cenit === 'object') out.cenit = cleanCenit(patch.cenit, current.cenit)
  if (patch.images && typeof patch.images === 'object') {
    const images = { ...current.images }
    for (const [family, kind] of Object.entries(patch.images)) if (typeof kind === 'string' && kind) images[family] = kind
    out.images = images
  }
  return out as Partial<Settings>
}

// the ghost kinds a test asks for (anything else dropped); none given: all of them
export function ghostKinds(kinds: unknown): GhostKind[] {
  return Array.isArray(kinds) ? GHOST_KINDS.filter((k) => kinds.includes(k)) : [...GHOST_KINDS]
}

// installation.json's layout: one key per line, values inline; an object of objects (ghosts)
// one entry per line
const inline = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}'
  }
  return JSON.stringify(v)
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const block = (v: unknown): string => {
  const entries = isObject(v) ? Object.entries(v) : []
  if (!entries.length || !entries.every(([, x]) => isObject(x))) return inline(v)
  return `{\n${entries.map(([k, x]) => `    ${JSON.stringify(k)}: ${inline(x)}`).join(',\n')}\n  }`
}

function formatConfig(raw: Record<string, unknown>) {
  const lines = Object.entries(raw).map(([k, v]) => `  ${JSON.stringify(k)}: ${block(v)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

// writes the current settings into installation.json, keeping everything else; returns the text
export function saveSettings(c: InstallationConfig): string {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    raw = { ...c } // missing or broken: write the whole running config
  }
  for (const k of EDITABLE) raw[k] = c[k]
  const text = formatConfig(raw)
  fs.writeFileSync(CONFIG_FILE, text)
  return text
}
