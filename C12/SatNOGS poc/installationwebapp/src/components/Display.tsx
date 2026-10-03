import { useEffect, useRef, type ReactNode } from 'react'
import { useStrings, type Strings } from '../i18n.ts'
import { link, useLink, useTicker } from '../link.ts'
import { AUDIO, DISPLAY_ID, SHOW_CURSOR, VIEW } from '../params.ts'
import { activeSlot } from '../timeline.ts'
import { AudioPlayer } from './AudioPlayer.tsx'
import { TopBar } from './TopBar.tsx'

const FLASH_MS = 1600

// Every monitor flashes its border at AOS (amber) and LOS (cyan) at the same instant
function PhaseFlash() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const el = ref.current
      if (!el) return
      const t = link.now()
      const s = activeSlot(link.state, t)
      let alpha = 0
      let color = 'var(--rx)'
      if (s) {
        const sinceAos = t - s.aos
        const sinceLos = t - s.los
        if (sinceAos >= 0 && sinceAos < FLASH_MS) alpha = 1 - sinceAos / FLASH_MS
        if (sinceLos >= 0 && sinceLos < FLASH_MS) {
          alpha = 1 - sinceLos / FLASH_MS
          color = 'var(--sat)'
        }
      }
      el.style.opacity = String(alpha)
      el.style.color = color
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div ref={ref} className="phase-flash" />
}

function Overlays() {
  const l = useLink()
  const text = useStrings()
  useTicker(500)
  return (
    <>
      {!l.connected && <div className="banner">{text.common.reconnecting}</div>}
      {l.connected && l.state && !l.state.slots.length && <div className="center-note">{text.common.noPassesYet}</div>}
      {Date.now() < l.identifyUntil && (
        <div className="identify">
          <div>{DISPLAY_ID}</div>
          <small>
            {VIEW}
            {AUDIO ? ` · ${text.common.sound}` : ''}
          </small>
        </div>
      )}
    </>
  )
}

// shell of a kiosk display: shared top bar, flashes, overlays, and the sound if it's this one's
export function Display({ title, children }: { title: keyof Strings['titles']; children: ReactNode }) {
  const l = useLink()
  return (
    <div className={l.state?.config.hideCursor === false || SHOW_CURSOR ? 'display' : 'display hide-cursor'}>
      <TopBar title={title} />
      <main className="display-body">{children}</main>
      <PhaseFlash />
      <Overlays />
      {AUDIO && <AudioPlayer />}
    </div>
  )
}
