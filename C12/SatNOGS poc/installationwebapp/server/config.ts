import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Settings } from '../src/shared/protocol.ts'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const CONFIG_FILE = path.join(ROOT, 'installation.json')

// one browser window of the installation (launch.ps1 reads these too)
export interface DisplayConfig {
  view: string
  screen: number // 1 = leftmost monitor (launch.ps1 -List)
  audio?: boolean // this display plays the sound
  params?: string // extra query, e.g. "camera=follow"
  position?: [number, number] // window position override, for awkward multi-DPI setups
}

// Settings change live (control page, or saving this file); the rest needs a restart
export interface InstallationConfig extends Settings {
  server: { host: string; port: number }
  downloads: string // listener.py's folder, relative to this project
  browser: string // chrome.exe / msedge.exe path; empty = find one
  displays: DisplayConfig[]
}

const DEFAULTS: InstallationConfig = {
  server: { host: '127.0.0.1', port: 5180 },
  downloads: '../downloads',
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
  waitSeconds: 20,
  approachSeconds: 8,
  departSeconds: 6,
  upcoming: 8,
  browser: '',
  displays: [],
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
}

const CHOICES: Record<string, string[]> = {
  location: ['station', 'neuquen'],
  imagery: ['esri', 'natural'],
  order: ['shuffle', 'chronological'],
}

export function loadConfig(): InstallationConfig {
  const raw = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {}
  return {
    ...DEFAULTS,
    ...raw,
    server: { ...DEFAULTS.server, ...raw.server },
    images: { ...DEFAULTS.images, ...raw.images },
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
  if (typeof patch.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(patch.language)) out.language = patch.language
  if (Array.isArray(patch.satellites) && patch.satellites.every((s) => typeof s === 'string')) out.satellites = patch.satellites
  if (patch.images && typeof patch.images === 'object') {
    const images = { ...current.images }
    for (const [family, kind] of Object.entries(patch.images)) if (typeof kind === 'string' && kind) images[family] = kind
    out.images = images
  }
  return out as Partial<Settings>
}

// installation.json's layout: one key per line, values inline, one display per line
const inline = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}'
  }
  return JSON.stringify(v)
}

function formatConfig(raw: Record<string, unknown>) {
  const lines = Object.entries(raw).map(([k, v]) =>
    k === 'displays' && Array.isArray(v) && v.length
      ? `  "displays": [\n${v.map((d) => `    ${inline(d)}`).join(',\n')}\n  ]`
      : `  ${JSON.stringify(k)}: ${inline(v)}`,
  )
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
