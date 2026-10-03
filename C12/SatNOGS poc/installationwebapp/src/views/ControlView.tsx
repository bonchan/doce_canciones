import { useEffect } from 'react'
import { link, useLink, useTicker } from '../link.ts'
import type { ControlAction } from '../shared/protocol.ts'
import { activeSlot, countdown, hhmm, phaseAt, progressAt } from '../timeline.ts'
import { SettingsPanel } from './SettingsPanel.tsx'

// Operator page (a normal browser tab, not a kiosk display)
export function ControlView() {
  const l = useLink()
  const now = useTicker(500)
  const state = l.state
  const active = activeSlot(state, now)
  const libraryCount = state?.library.passes

  useEffect(() => {
    if (l.connected) link.send({ type: 'library' })
  }, [l.connected, libraryCount])

  const control = (action: ControlAction) => link.send({ type: 'control', action })

  return (
    <div className="page">
      <header className="page-head">
        <h1>SatNOGS installation</h1>
        <span className={l.connected ? 'ok' : 'rx'}>{l.connected ? 'connected' : 'reconnecting…'}</span>
      </header>

      <section>
        <h2>On air</h2>
        {active ? (
          <p>
            <b>{active.pass.satellite}</b> · {active.pass.station_name ?? 'unknown station'} · {phaseAt(active, now)}{' '}
            {phaseAt(active, now) === 'pass' ? `${Math.floor(progressAt(active, now) * 100)}%` : `AOS ${countdown(active.aos - now)}`}
          </p>
        ) : (
          <p className="dim">nothing scheduled</p>
        )}
        <div className="buttons">
          <button onClick={() => control('skip')}>skip to the next pass</button>
          <button onClick={() => control('restart')}>restart this pass</button>
          <button onClick={() => control('identify')}>identify displays</button>
          <button onClick={() => control('reload')}>reload displays</button>
        </div>
      </section>

      <section>
        <h2>Settings</h2>
        <SettingsPanel />
      </section>

      <section>
        <h2>Displays ({l.displays.length})</h2>
        <table className="displays">
          <thead>
            <tr>
              <th>id</th>
              <th>view</th>
              <th>sound</th>
              <th>address</th>
              <th>connected</th>
              <th>errors</th>
            </tr>
          </thead>
          <tbody>
            {l.displays.map((d, i) => (
              <tr key={`${d.id}-${i}`}>
                <td>{d.id}</td>
                <td>{d.view || 'menu'}</td>
                <td>{d.audio ? '♪' : ''}</td>
                <td className="dim">{d.address}</td>
                <td className="dim">{countdown(Date.now() - d.since)} ago</td>
                <td className="error-cell" title={d.errors ? `${d.errors} · ${d.lastError}` : undefined}>
                  {d.errors ? `${d.errors} · ${d.lastError}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Up next</h2>
        <ol>
          {state?.slots.slice(1).map((s) => (
            <li key={s.id}>
              {hhmm(s.aos)} · {s.pass.satellite} · {s.pass.station_name ?? 'unknown station'}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>Library ({l.library.length})</h2>
        <table>
          <tbody>
            {l.library.map((p) => (
              <tr key={p.id}>
                <td className="dim">{p.start.slice(0, 16).replace('T', ' ')}</td>
                <td>{p.satellite}</td>
                <td>{p.station_name ?? '—'}</td>
                <td>{p.max_altitude != null ? `${p.max_altitude.toFixed(0)}°` : ''}</td>
                <td>{p.audio ? '♪' : ''}</td>
                <td>
                  <button onClick={() => link.send({ type: 'queue', passId: p.id })}>play next</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
