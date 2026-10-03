// Display languages: one JSON per language in ./lang. The control page picks one for every
// display (a live setting); each display also remembers it, to start in it after a reload.
// To add a language: copy lang/en.json, translate it, and add it to LANGUAGES below.
import en from './lang/en.json'
import esJson from './lang/es.json'
import { link, useLink } from './link.ts'

export type Strings = typeof en

const es: Strings = esJson // a key missing from the translation is a type error

export const LANGUAGES: Record<string, Strings> = { en, es }

const KEY = 'satnogs-installation-language'

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null // storage blocked: English until the server answers
  }
}

let saved = remembered()

link.subscribe(() => {
  const language = link.state?.config.language
  if (!language || language === saved) return
  saved = language
  try {
    localStorage.setItem(KEY, language)
  } catch {
    // not remembered: the server sends it again on every connection
  }
})

// read every frame by canvases and Cesium labels, so a change shows up without re-rendering
export function strings(): Strings {
  return LANGUAGES[link.state?.config.language ?? saved ?? 'en'] ?? en
}

export function useStrings(): Strings {
  useLink()
  return strings()
}

// fmt('AOS in {countdown}', { countdown: '01:20' })
export const fmt = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all))

// a number with the language's decimal separator: 45.6 / 45,6
const formats = new Map<string, Intl.NumberFormat>()

export function num(value: number, digits = 0): string {
  const locale = strings().locale
  const key = `${locale}|${digits}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
    formats.set(key, format)
  }
  return format.format(value)
}
