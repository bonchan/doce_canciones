import type { ReactNode } from 'react'
import { Display } from '../components/Display.tsx'
import { fmt, num, useStrings, type Strings } from '../i18n.ts'
import { useLink, useTicker } from '../link.ts'
import type { Slot } from '../shared/protocol.ts'
import { activeSlot, countdown, hhmm, phaseAt, progressAt, recorded } from '../timeline.ts'

type Status = 'done' | 'current' | 'next'

function StatusCell({ slot, status, now, text }: { slot: Slot; status: Status; now: number; text: Strings }) {
  const vars = { countdown: countdown(slot.aos - now) }
  if (status === 'done') return <span className="ok">{text.schedule.received}</span>
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

// Departures board: the last passes received, the one on air, the upcoming ones
export function ScheduleView() {
  const l = useLink()
  const text = useStrings()
  const now = useTicker(250)
  const state = l.state
  const active = activeSlot(state, now)
  const rows: [Slot, Status][] = []
  if (state) {
    for (const s of state.history.slice(0, 3).reverse()) rows.push([s, 'done'])
    for (const s of state.slots) rows.push([s, s.end <= now ? 'done' : s === active ? 'current' : 'next'])
  }
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
          <tbody>
            {rows.map(([s, status]) => (
              <tr key={s.id} className={`row-${status}`}>
                <td>
                  <StatusCell slot={s} status={status} now={now} text={text} />
                </td>
                <td>{hhmm(s.aos, text.locale)}</td>
                <td>{s.pass.satellite}</td>
                <td className="station">{s.pass.station_name ?? '—'}</td>
                <td className="dim">{recorded(s.pass)}</td>
                <td>{s.pass.max_altitude != null ? `${num(s.pass.max_altitude)}°` : '—'}</td>
                <td>{countdown(s.los - s.aos)}</td>
                <td>{s.pass.audio ? text.schedule.apt : text.schedule.digital}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer>{footer}</footer>
      </div>
    </Display>
  )
}
