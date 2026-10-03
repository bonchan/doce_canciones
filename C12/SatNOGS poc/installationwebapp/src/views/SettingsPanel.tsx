import { useRef, useState } from 'react'
import { LANGUAGES } from '../i18n.ts'
import { DEFAULT_IMAGE, imageGroup } from '../images.ts'
import { link, useLink } from '../link.ts'
import type { PassSummary, Settings } from '../shared/protocol.ts'

const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64]

const set = (patch: Partial<Settings>) => link.send({ type: 'settings', patch })

// a number that applies when typing pauses, on Enter, or when leaving the field
function NumberField(props: { value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
  const { value, min, max, step, onCommit } = props
  const [draft, setDraft] = useState<string | null>(null) // null: showing the live value
  const timer = useRef<number | undefined>(undefined)
  const commit = (text: string) => {
    window.clearTimeout(timer.current)
    const v = Number(text)
    if (text.trim() !== '' && Number.isFinite(v) && v !== value) onCommit(v)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(text), 700)
      }}
      onBlur={(e) => {
        commit(e.target.value)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

// image kinds seen per satellite family, most common first
function kindsByFamily(passes: PassSummary[]): [string, [string, number][]][] {
  const families = new Map<string, Map<string, number>>()
  for (const p of passes) {
    const family = imageGroup(p)
    const kinds = families.get(family) ?? new Map<string, number>()
    for (const k of p.kinds) kinds.set(k, (kinds.get(k) ?? 0) + 1)
    families.set(family, kinds)
  }
  return [...families]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, kinds]) => [family, [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))])
}

// Installation settings, live on every display (the server saves them into installation.json)
export function SettingsPanel() {
  const l = useLink()
  const s = l.state?.config
  const lib = l.state?.library
  if (!s || !lib) return <p className="dim">waiting for the server…</p>

  const satellites = Object.keys(lib.satellites).sort()
  const selected = s.satellites.length ? s.satellites : satellites
  const toggleSatellite = (name: string) => {
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    if (next.length) set({ satellites: next.length === satellites.length ? [] : next }) // [] = all
  }

  return (
    <div className="settings">
      <div className="field">
        <span>speed</span>
        <NumberField value={s.speed} min={0.05} max={100} step={0.25} onCommit={(speed) => set({ speed })} />
        {SPEEDS.map((v) => (
          <button key={v} className={s.speed === v ? 'active' : ''} onClick={() => set({ speed: v })}>
            {v}×
          </button>
        ))}
      </div>
      <label className="field">
        <span>volume</span>
        <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => set({ volume: +e.target.value })} />
        <span className="dim">{Math.round(s.volume * 100)}%</span>
      </label>
      <label className="field">
        <span>hide the mouse pointer</span>
        <input type="checkbox" checked={s.hideCursor} onChange={(e) => set({ hideCursor: e.target.checked })} />
      </label>
      <label className="field">
        <span>display language</span>
        <select value={s.language} onChange={(e) => set({ language: e.target.value })}>
          {!LANGUAGES[s.language] && <option value={s.language}>{s.language}</option>}
          {Object.entries(LANGUAGES).map(([code, lang]) => (
            <option key={code} value={code}>
              {lang.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>phrase in the received image</span>
        <input type="checkbox" checked={s.phrases} onChange={(e) => set({ phrases: e.target.checked })} />
      </label>
      <label className="field">
        <span>location</span>
        <select value={s.location} onChange={(e) => set({ location: e.target.value as Settings['location'] })}>
          <option value="station">recording station</option>
          <option value="neuquen">Neuquén</option>
        </select>
      </label>
      <label className="field">
        <span>map</span>
        <select value={s.imagery} onChange={(e) => set({ imagery: e.target.value as Settings['imagery'] })}>
          <option value="esri">Esri satellite</option>
          <option value="natural">Natural Earth (offline)</option>
        </select>
      </label>
      <label className="field">
        <span>order</span>
        <select value={s.order} onChange={(e) => set({ order: e.target.value as Settings['order'] })}>
          <option value="shuffle">shuffle</option>
          <option value="chronological">chronological</option>
        </select>
      </label>
      <div className="field">
        <span>satellites</span>
        {satellites.map((name) => (
          <label key={name} className="check">
            <input type="checkbox" checked={selected.includes(name)} onChange={() => toggleSatellite(name)} />
            {name} <span className="dim">({lib.satellites[name]})</span>
          </label>
        ))}
      </div>
      {kindsByFamily(l.library).map(([family, kinds]) => {
        const current = s.images[family] ?? DEFAULT_IMAGE[family] ?? 'normal'
        return (
          <label key={family} className="field">
            <span>{family} image</span>
            <select value={current} onChange={(e) => set({ images: { [family]: e.target.value } })}>
              {!kinds.some(([k]) => k === current) && <option value={current}>{current}</option>}
              {kinds.map(([k, n]) => (
                <option key={k} value={k}>
                  {k.replace(/[-_]+/g, ' ')} ({n})
                </option>
              ))}
            </select>
          </label>
        )
      })}
      <label className="field">
        <span>wait between passes</span>
        <NumberField value={s.waitSeconds} min={0} max={3600} step={1} onCommit={(waitSeconds) => set({ waitSeconds })} />
        <span className="dim">s</span>
      </label>
      <label className="field">
        <span>approach (fast-forward)</span>
        <NumberField value={s.approachSeconds} min={0} max={600} step={1} onCommit={(approachSeconds) => set({ approachSeconds })} />
        <span className="dim">s</span>
      </label>
      <label className="field">
        <span>after LOS</span>
        <NumberField value={s.departSeconds} min={0} max={600} step={1} onCommit={(departSeconds) => set({ departSeconds })} />
        <span className="dim">s</span>
      </label>
      <label className="field">
        <span>passes scheduled ahead</span>
        <NumberField value={s.upcoming} min={1} max={50} step={1} onCommit={(upcoming) => set({ upcoming })} />
      </label>
      <p className="dim">Changes apply right away on every display and are saved to installation.json.</p>
    </div>
  )
}
