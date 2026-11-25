import { useRef, useState } from 'react'
import { LANGUAGES } from '../i18n.ts'
import { DEFAULT_IMAGE, imageGroup } from '../images.ts'
import { link, useLink } from '../link.ts'
import { CENIT_DEFAULTS, CENIT_RANGES, type CenitSettings } from '../shared/cenit.ts'
import { RECEIVER_DEFAULTS, RECEIVER_RANGES, type ReceiverSettings } from '../shared/receiver.ts'
import { countdown } from '../timeline.ts'
import {
  GHOST_APPEAR,
  GHOST_DEFAULTS,
  GHOST_DELAY,
  GHOST_FAMILY,
  GHOST_KINDS,
  GHOST_PROMINENCE,
  type GhostAppear,
  type GhostKind,
  type GhostSettings,
  type GhostsSettings,
} from '../shared/ghosts.ts'
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

const GHOST_NAMES: Record<GhostKind, string> = {
  tear: 'torn lines',
  echo: 'echo',
  roll: 'rolling frame',
  blocks: 'blocks',
  smear: 'smear',
  mosaic: 'mosaic',
}

const APPEAR_NAMES: Record<GhostAppear, string> = {
  low: 'more with the satellite low',
  high: 'more with the satellite high',
  steady: 'steady',
  off: 'off',
}

// a test: these ghosts right now on every display, at their prominence
const testGhosts = (kinds: GhostKind[]) => link.send({ type: 'ghost', kinds })

// The reception ghosts (components/Ghosts.tsx): all on or off, and each kind on its own: when it
// appears, every how many seconds (on average; for low / high where there are most), how
// strongly, and a test.
function GhostsFields({ on, ghosts }: { on: boolean; ghosts: GhostsSettings }) {
  const change = (kind: GhostKind, patch: Partial<GhostSettings>) =>
    set({ ghosts: { ...ghosts, [kind]: { ...(ghosts[kind] ?? GHOST_DEFAULTS[kind]), ...patch } } })
  return (
    <>
      <div className="field">
        <span>ghosts: the sky photo breaking into the signal</span>
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => set({ ghostsOn: e.target.checked })} />
          {on ? 'on' : 'off (tests still show)'}
        </label>
        <button onClick={() => testGhosts([...GHOST_KINDS])}>test all now</button>
      </div>
      <div className="field">

        <table className={on ? 'ghost-settings' : 'ghost-settings all-off'}>
          <thead>
            <tr>
              <th />
              <th>appears</th>
              <th>every</th>
              <th>prominence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {GHOST_KINDS.map((kind) => {
              const g = ghosts[kind] ?? GHOST_DEFAULTS[kind]
              return (
                <tr key={kind} className={g.appear === 'off' ? 'off' : ''}>
                  <td>
                    {GHOST_NAMES[kind]} <span className="dim">{GHOST_FAMILY[kind]}</span>
                  </td>
                  <td>
                    <select value={g.appear} onChange={(e) => change(kind, { appear: e.target.value as GhostAppear })}>
                      {GHOST_APPEAR.map((a) => (
                        <option key={a} value={a}>
                          {APPEAR_NAMES[a]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <NumberField value={g.delay} min={GHOST_DELAY[0]} max={GHOST_DELAY[1]} step={0.5} onCommit={(delay) => change(kind, { delay })} />
                    <span className="dim"> s</span>
                  </td>
                  <td>
                    <input
                      type="range"
                      min={GHOST_PROMINENCE[0]}
                      max={GHOST_PROMINENCE[1]}
                      step={10}
                      value={g.prominence}
                      onChange={(e) => change(kind, { prominence: +e.target.value })}
                    />
                    <span className="dim"> {g.prominence}%</span>
                  </td>
                  <td>
                    <button onClick={() => testGhosts([kind])}>test now</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// the look-up moment's settings: label, unit, step; numbers typed or (%) on a slider
const CENIT_FIELDS: [keyof typeof CENIT_RANGES, string, 's' | '%', number][] = [
  ['fadeIn', 'fade in', 's', 0.1],
  ['hold', 'hold, at the top of the pass', 's', 0.5],
  ['fadeOut', 'fade out', 's', 0.1],
  ['opacity', 'opacity', '%', 5],
  ['zoom', 'zoom', '%', 5],
  ['drift', 'drift with the wind', '%', 0.5],
  ['minPass', 'only on passes longer than', 's', 1],
]

// The look-up moment (components/Cenit.tsx): the plain sky photo, full screen, at the top of a
// pass with one (not on the globes): on or off, its timing and look, and a test.
function CenitFields({ c }: { c: CenitSettings }) {
  const change = (patch: Partial<CenitSettings>) => set({ cenit: { ...c, ...patch } })
  return (
    <>
      <div className="field">
        <span>look up: the plain sky photo at the top of the pass</span>
        <label className="check">
          <input type="checkbox" checked={c.on} onChange={(e) => change({ on: e.target.checked })} />
          {c.on ? 'on' : 'off (a test still shows)'}
        </label>
        <button onClick={() => link.send({ type: 'cenit' })}>test now</button>
      </div>
      <div className="field">
        <table className={c.on ? 'ghost-settings' : 'ghost-settings all-off'}>
          <tbody>
            {CENIT_FIELDS.map(([key, label, unit, step]) => {
              const [min, max] = CENIT_RANGES[key]
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td>
                    {unit === '%' ? (
                      <input type="range" min={min} max={max} step={step} value={c[key]} onChange={(e) => change({ [key]: +e.target.value })} />
                    ) : (
                      <NumberField value={c[key]} min={min} max={max} step={step} onCommit={(v) => change({ [key]: v })} />
                    )}
                    <span className="dim">
                      {' '}
                      {unit === '%' ? c[key] : ''}
                      {unit}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// a text that applies on Enter or when leaving the field
function TextField(props: { value: string; width?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="text"
      style={{ width: props.width }}
      value={draft ?? props.value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const v = e.target.value.trim()
        if (v && v !== props.value) props.onCommit(v)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

// The real passes (server/receiver.ts): the real receiver's passes, live on every screen. On or
// off, its address, the lowest pass that goes live, and a moment after AOS before switching.
function ReceiverFields({ r }: { r: ReceiverSettings }) {
  const l = useLink()
  const change = (patch: Partial<ReceiverSettings>) => set({ receiver: { ...r, ...patch } })
  const now = link.now()
  const next = l.state?.slots.find((x) => x.pass.live && x.los > now)
  return (
    <>
      <div className="field">
        <span>real passes: the receiver's, live on every screen</span>
        <label className="check">
          <input type="checkbox" checked={r.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          {r.enabled ? 'on' : 'off'}
        </label>
        {r.enabled && (
          <span className="dim">
            {next
              ? now >= next.aos
                ? `live now: ${next.pass.satellite}`
                : `next: ${next.pass.satellite} in ${countdown(next.aos - now)}, up to ${next.pass.max_altitude ?? '?'}°`
              : 'no real pass ahead (yet)'}
          </span>
        )}
      </div>
      <div className="field">
        <table className={r.enabled ? 'ghost-settings' : 'ghost-settings all-off'}>
          <tbody>
            <tr>
              <td>receiver (raspberry_sat)</td>
              <td>
                <TextField value={r.url} width="18em" onCommit={(url) => change({ url })} />
              </td>
            </tr>
            <tr>
              <td>only passes higher than</td>
              <td>
                <NumberField
                  value={r.minElevation}
                  min={RECEIVER_RANGES.minElevation[0]}
                  max={RECEIVER_RANGES.minElevation[1]}
                  step={1}
                  onCommit={(minElevation) => change({ minElevation })}
                />
                <span className="dim"> °</span>
              </td>
            </tr>
            <tr>
              <td>finished passes</td>
              <td>
                <label className="check">
                  <input type="checkbox" checked={r.importPasses} onChange={(e) => change({ importPasses: e.target.checked })} />
                  into the library
                </label>
                <label className="check">
                  <input type="checkbox" checked={r.playImported} onChange={(e) => change({ playImported: e.target.checked })} />
                  and play it right after
                </label>
              </td>
            </tr>
            <tr>
              <td>switch to it after AOS</td>
              <td>
                <NumberField
                  value={r.joinDelay}
                  min={RECEIVER_RANGES.joinDelay[0]}
                  max={RECEIVER_RANGES.joinDelay[1]}
                  step={1}
                  onCommit={(joinDelay) => change({ joinDelay })}
                />
                <span className="dim"> s</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
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
        <span>phrase: words around the Earth, into the image</span>
        <input type="checkbox" checked={s.phrases} onChange={(e) => set({ phrases: e.target.checked })} />
      </label>
      <label className="field">
        <span>sky: passes with a photo of the sky from below</span>
        <input type="range" min={0} max={100} step={5} value={s.sky} onChange={(e) => set({ sky: +e.target.value })} />
        <span className="dim">
          {s.sky}% · {l.state?.sky?.length ?? 0} photos
        </span>
      </label>
      <GhostsFields on={s.ghostsOn !== false} ghosts={s.ghosts ?? GHOST_DEFAULTS} />
      <CenitFields c={{ ...CENIT_DEFAULTS, ...s.cenit }} />
      <ReceiverFields r={{ ...RECEIVER_DEFAULTS, ...s.receiver }} />
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
