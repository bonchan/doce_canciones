import type { CSSProperties, ReactNode } from 'react'
import { random } from '../art/phrases.ts'
import { skyFor } from '../art/sky.ts'
import { useSkyStrip } from '../art/skyImages.ts'
import { Display } from '../components/Display.tsx'
import { fmt, num, useStrings, type Strings } from '../i18n.ts'
import { useLink, useTicker } from '../link.ts'
import type { AfterLos, Slot } from '../shared/protocol.ts'
import type { Pass } from '../shared/types.ts'
import { activeSlot, countdown, hhmm, phaseAt, progressAt, recorded } from '../timeline.ts'

type Status = 'done' | 'current' | 'processing' | 'next'

// A live pass past LOS that has its row under the one on air: the Pi processing it, or finished
// without an image (till the pass on air then ends) ...
const processingRow = (a: AfterLos | undefined, now: number) =>
  !!a && (a.state === 'processing' || (a.state === 'empty' && now < a.until))
// ... and one whose imported replay takes its place: on next, then received like the others
const replaced = (a: AfterLos | undefined) => a?.state === 'received' && a.pass != null

// a pass of our own antenna (the real receiver): live (coming or on air), or received and imported
const isReal = (s: Slot) => !!(s.pass.live || s.pass.ours)

// the receiver's next pass at its own times, for the pinned row before the timeline plans it
function realSlot(p: Pass): Slot {
  const aos = Date.parse(p.start)
  const los = Date.parse(p.end ?? p.start)
  return { id: p.id, pass: p, start: aos, approachAt: aos, aos, los, end: los }
}

// a live pass past LOS while the Pi decodes it: the step, and how far when it can tell (else a bar
// going to and fro)
function Processing({ after, text }: { after: Extract<AfterLos, { state: 'processing' }>; text: Strings }) {
  const t = text.schedule
  const label = after.step ? fmt(t.processingStep, { step: t.steps[after.step] }) : t.processing
  return (
    <span className="proc">
      {after.percent != null ? `${label} ${after.percent}%` : label}
      <span className={after.percent == null ? 'mini-bar busy' : 'mini-bar'}>
        <span style={after.percent == null ? undefined : { width: `${after.percent}%` }} />
      </span>
    </span>
  )
}

function StatusCell(props: { slot: Slot; status: Status; now: number; text: Strings; after?: AfterLos }) {
  const { slot, status, now, text, after } = props
  const vars = { countdown: countdown(slot.aos - now) }
  // a live pass past LOS (its after-LOS phase on air, then its row under the one on air): the Pi's say
  if (slot.pass.live && after && (status !== 'next' && (status !== 'current' || phaseAt(slot, now) === 'depart'))) {
    if (after.state === 'processing') return <Processing after={after} text={text} />
    if (after.state === 'empty') return <span className="dim">{text.schedule.noImage}</span>
  }
  if (status === 'done' || status === 'processing') return <span className="ok">{text.schedule.received}</span>
  if (status === 'next') return <span className="dim">{fmt(text.schedule.aosIn, vars)}</span>
  const phase = phaseAt(slot, now)
  if (phase === 'pass') {
    const pct = Math.floor(progressAt(slot, now) * 100)
    return (
      <span className="rx">
        {fmt(text.schedule.receiving, { pct })}
        <span className="mini-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
    )
  }
  if (phase === 'depart') return <span className="sat">{text.schedule.los}</span>
  return <span className="sat">{fmt(phase === 'approach' ? text.schedule.acquiring : text.schedule.next, vars)}</span>
}

function Row(props: { slot: Slot; status: Status; now: number; text: Strings; sky: string | null; after?: AfterLos }) {
  const { slot: s, status, now, text } = props
  // a strip of the pass's sky across its row, at a height of the photo of its own
  const strip = useSkyStrip(props.sky)
  const style = strip
    ? ({ '--sky': `url("${strip}")`, '--sky-y': `${Math.round(20 + random(s.id)() * 60)}%` } as CSSProperties)
    : undefined
  const real = isReal(s)
  const classes = [`row-${status}`, strip && 'has-sky', real && 'real'].filter(Boolean).join(' ')
  return (
    <tr className={classes} style={style}>
      <td>
        <StatusCell slot={s} status={status} now={now} text={text} after={props.after} />
      </td>
      <td>{hhmm(s.aos, text.locale)}</td>
      <td className="sat-name">
        {s.pass.satellite}
        {s.pass.live && <span className="real-tag">{text.live.tag}</span>}
      </td>
      <td className="station">{s.pass.station_name ?? '—'}</td>
      <td className="dim">{recorded(s.pass)}</td>
      <td>{s.pass.max_altitude != null ? `${num(s.pass.max_altitude)}°` : '—'}</td>
      <td>{countdown(s.los - s.aos)}</td>
      <td>{s.pass.audio ? text.schedule.apt : text.schedule.digital}</td>
    </tr>
  )
}

// Departures board, top to bottom: the last 3 passes received; the one on air (live or a replay);
// a live pass past LOS while the Pi processes it (how far); the upcoming ones, the processed live
// pass first once its images are over; the real receiver's next pass pinned under the list (not
// from the live one's AOS till its processed replay is on air). Those with a sky photo over a strip
// of it; real passes in their own colour, the live one tagged.
export function ScheduleView() {
  const l = useLink()
  const text = useStrings()
  const now = useTicker(250)
  const state = l.state
  const active = activeSlot(state, now)
  const liveOn = !!active?.pass.live
  const rows: [Slot, Status][] = []
  let pinned: [Slot, Status] | null = null
  if (state) {
    const after = (s: Slot) => (s.pass.live ? l.afterLos[s.pass.id] : undefined)
    const received = state.history.filter((s) => !processingRow(after(s), now) && !replaced(after(s)))
    for (const s of received.slice(0, 3).reverse()) rows.push([s, 'done'])
    const processing = state.history.find((s) => processingRow(after(s), now))
    for (const s of state.slots) {
      if (s.pass.live && s !== active) continue // a real pass still to come: pinned below
      rows.push([s, s.end <= now ? 'done' : s === active ? 'current' : 'next'])
      if (s === active && processing) rows.push([processing, 'processing'])
    }
    if (processing && !active) rows.push([processing, 'processing'])
    // the live pass's processed replay still to play: the next real pass waits for it
    const latest = state.history.find((s) => s.pass.live)
    const a = latest && after(latest)
    const queued =
      a?.state === 'received' && a.pass != null && state.slots.some((s) => s.pass.id === a.pass && s !== active && s.end > now)
    const next = liveOn || processing || queued ? null : state.real?.find((p) => Date.parse(p.end ?? p.start) > now)
    if (next) {
      const slot = state.slots.find((s) => s.pass.id === next.id) ?? realSlot(next)
      pinned = [slot, now < slot.aos ? 'next' : 'current']
    }
  }
  const row = ([s, status]: [Slot, Status]) => (
    <Row
      key={s.id}
      slot={s}
      status={status}
      now={now}
      text={text}
      sky={s.pass.live ? null : skyFor(s.id, state?.sky, state?.config.sky)}
      after={s.pass.live ? l.afterLos[s.pass.id] : undefined}
    />
  )
  const lib = state?.library
  let footer: ReactNode = null
  if (lib) {
    const sats = Object.entries(lib.satellites)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n}`)
      .join(' · ')
    footer = fmt(text.schedule.library, { passes: lib.passes, stations: lib.stations, satellites: sats })
  }

  return (
    <Display title="passes">
      <div className="schedule">
        <div className="schedule-list">
          <table>
            <thead>
              <tr>
                <th>{text.schedule.status}</th>
                <th>{text.schedule.aos}</th>
                <th>{text.schedule.satellite}</th>
                <th>{text.schedule.station}</th>
                <th>{text.schedule.recorded}</th>
                <th>{text.schedule.maxElevation}</th>
                <th>{text.schedule.length}</th>
                <th>{text.schedule.signal}</th>
              </tr>
            </thead>
            <tbody>{rows.map(row)}</tbody>
            {/* the real receiver's next pass, stuck under the list */}
            {pinned && (
              <tfoot>
                <tr className="gap">
                  <td colSpan={8} />
                </tr>
                {row(pinned)}
              </tfoot>
            )}
          </table>
        </div>
        <footer>{footer}</footer>
      </div>
    </Display>
  )
}
