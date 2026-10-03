// Display errors go to the server (its console and the control page) so they can be looked
// into later. The same message at most every 10 s: a broken frame repeats 60 times a second.
import { link } from './link.ts'
import { DISPLAY_ID } from './params.ts'

const lastSent = new Map<string, number>()

export function reportError(where: string, error: unknown) {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message} ${error.stack?.split('\n')[1]?.trim() ?? ''}` : String(error)
  const message = `${where}: ${detail}`.trim().slice(0, 500)
  const now = Date.now()
  if ((lastSent.get(message) ?? 0) > now - 10_000) return
  lastSent.set(message, now)
  console.error(message, error)
  link.send({ type: 'error', message })
}

window.addEventListener('error', (e) => reportError('error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason))

const RELOADS_KEY = `satnogs-display-reloads-${DISPLAY_ID}`

// Reloads this display in 2 s (time to send the report), unless it already reloaded 3 times in
// the last 10 minutes: then reloading isn't fixing it, and a flickering screen is worse.
// Returns whether it will reload.
export function reloadDisplay(reason: string): boolean {
  const now = Date.now()
  let times: number[] = []
  try {
    times = JSON.parse(sessionStorage.getItem(RELOADS_KEY) ?? '[]')
  } catch {
    // unreadable: count from zero
  }
  times = times.filter((t) => t > now - 600_000)
  if (times.length >= 3) return false
  try {
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...times, now]))
  } catch {
    // not counted: storage blocked
  }
  reportError('reload', reason)
  setTimeout(() => location.reload(), 2000)
  return true
}
