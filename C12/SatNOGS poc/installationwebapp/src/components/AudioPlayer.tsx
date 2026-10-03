import { useEffect, useRef, useState } from 'react'
import { useStrings } from '../i18n.ts'
import { link } from '../link.ts'
import { activeSlot, phaseAt } from '../timeline.ts'

// Plays the recording of the pass on air, locked to the shared clock: it seeks when it's
// more than 0.4 s off and nudges the playback rate for smaller drift.
class FollowPlayer {
  blocked = false // the browser wants a click before playing sound
  private el: HTMLAudioElement | null = null
  private src: string | null = null
  private starting = false
  private retryAt = 0

  update() {
    const state = link.state
    const now = link.now()
    const slot = activeSlot(state, now)
    const url = slot?.pass.audio ?? null
    if (!state || !slot || !url || phaseAt(slot, now) !== 'pass') return this.stop()
    const speed = state.config.speed
    if (this.src !== url) {
      this.stop()
      this.el = new Audio(url)
      this.el.preload = 'auto'
      this.src = url
    }
    const el = this.el!
    el.volume = Math.min(1, Math.max(0, state.config.volume))
    el.preservesPitch = speed === 1
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return
    const target = ((now - slot.aos) / 1000) * speed
    if (target >= el.duration) {
      if (!el.paused) el.pause()
      return
    }
    if (el.paused) {
      if (this.starting || Date.now() < this.retryAt) return
      this.starting = true
      el.currentTime = target
      el.playbackRate = speed
      el.play()
        .then(() => {
          this.blocked = false
        })
        .catch(() => {
          this.blocked = true
          this.retryAt = Date.now() + 2000
        })
        .finally(() => {
          this.starting = false
        })
      return
    }
    const drift = el.currentTime - target
    if (Math.abs(drift) > 0.4) el.currentTime = target
    else el.playbackRate = speed * (1 - Math.max(-0.02, Math.min(0.02, drift / 2)))
  }

  // from a click (kiosk mode allows autoplay, a normal browser tab doesn't)
  unlock() {
    this.retryAt = 0
    this.el
      ?.play()
      .then(() => {
        this.blocked = false
      })
      .catch(() => {})
  }

  stop() {
    if (!this.el) return
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
    this.el = null
    this.src = null
    this.blocked = false
  }
}

export function AudioPlayer() {
  const text = useStrings()
  const playerRef = useRef<FollowPlayer | null>(null)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    const player = new FollowPlayer()
    playerRef.current = player
    // an interval, not animation frames: keeps going if the window is covered
    const id = setInterval(() => {
      player.update()
      setBlocked(player.blocked)
    }, 100)
    return () => {
      clearInterval(id)
      player.stop()
    }
  }, [])

  if (!blocked) return null
  return (
    <button className="unlock" onClick={() => playerRef.current?.unlock()}>
      {text.common.enableSound}
    </button>
  )
}
