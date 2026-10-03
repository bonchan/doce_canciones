import { useEffect, useRef } from 'react'
import { fmt, useStrings, type Strings } from '../i18n.ts'
import { link, useLink, useTicker } from '../link.ts'
import type { Slot } from '../shared/protocol.ts'
import { activeSlot, clock, countdown, phaseAt, progressAt, type Phase } from '../timeline.ts'

export const PHASE_COLOR: Record<Phase, string> = {
  waiting: 'var(--dim)',
  approach: 'var(--sat)',
  pass: 'var(--rx)',
  depart: 'var(--sat)',
}

export function phaseText(s: Slot, t: number, text: Strings) {
  return fmt(text.phase[phaseAt(s, t)], { countdown: countdown(s.aos - t), pct: Math.floor(progressAt(s, t) * 100) })
}

// The same strip on every display: pass, phase, clock, and the reception progress line
export function TopBar({ title }: { title: keyof Strings['titles'] }) {
  const l = useLink()
  const text = useStrings()
  const now = useTicker(250)
  const slot = activeSlot(l.state, now)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const t = link.now()
      const s = activeSlot(link.state, t)
      if (barRef.current) barRef.current.style.width = s ? `${progressAt(s, t) * 100}%` : '0'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <header className="topbar">
      <div className="tb-left">
        <span className={l.connected ? 'tb-dot' : 'tb-dot off'} />
        SatNOGS <span className="dim">· {text.titles[title]}</span>
      </div>
      <div className="tb-center">
        {slot ? (
          <>
            <b>{slot.pass.satellite}</b>
            <span className="dim"> · </span>
            {slot.pass.station_name ?? text.common.unknownStation}
            <span className="tb-phase" style={{ color: PHASE_COLOR[phaseAt(slot, now)] }}>
              {phaseText(slot, now, text)}
            </span>
          </>
        ) : (
          <span className="dim">{text.common.noPasses}</span>
        )}
      </div>
      <div className="tb-right">{clock(now, text.locale)}</div>
      <div className="tb-progress">
        <div ref={barRef} />
      </div>
    </header>
  )
}
