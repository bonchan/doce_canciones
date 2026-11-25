// The installation's shared timeline: the pass on air and the next ones, back to back.
// Displays only draw from these absolute times, so they all show the same moment.
// Live passes (receiver.ts: the real receiver's upcoming passes) keep their real times. Replays go
// on until the live pass's AOS; then the screens switch straight to it, already receiving (no
// approach, no waiting): the replay on air is cut there, and the ones after the live pass (those
// planned to start after its AOS included) follow on from its end.
import type { Slot } from '../src/shared/protocol.ts'
import type { Pass } from '../src/shared/types.ts'
import type { InstallationConfig } from './config.ts'

const HISTORY = 12

// how long the reception lasts: the recording, else the observation window, else 15 min
function receptionSeconds(p: Pass): number {
  if (p.audio && p.audio_seconds && p.audio_seconds > 30) return p.audio_seconds
  const window = p.end ? (Date.parse(p.end) - Date.parse(p.start)) / 1000 : 0
  return window > 60 ? window : 900
}

export class Conductor {
  passes: Pass[] = []
  slots: Slot[] = [] // [0] on air, then upcoming
  history: Slot[] = [] // most recent first
  onChange: () => void = () => {}
  private nextId = 1
  private picked: number[] = []
  private live: Pass[] = [] // the real receiver's upcoming passes, soonest first

  constructor(private cfg: InstallationConfig) {}

  // New settings, live: the pass on air keeps its place (same fraction of the phase it's in)
  // and continues at the new timing; the upcoming ones are re-timed, or re-picked when the
  // order or the satellites changed.
  setConfig(cfg: InstallationConfig) {
    const prev = this.cfg
    this.cfg = cfg
    if (prev.order !== cfg.order || prev.satellites.join('|') !== cfg.satellites.join('|')) {
      this.slots.length = Math.min(this.slots.length, 1)
    }
    if (this.slots.length && !this.slots[0].pass.live) this.slots[0] = this.retimeOnAir(this.slots[0], Date.now())
    this.slots.length = Math.min(this.slots.length, 1 + cfg.upcoming)
    this.rechain(1)
    this.fill()
    this.onChange()
  }

  // new library scan: refresh the scheduled passes, drop the ones that are gone
  setPasses(passes: Pass[]) {
    const byId = new Map(passes.map((p) => [p.id, p]))
    this.passes = passes
    const [current, ...upcoming] = this.slots
    const kept = upcoming.filter((s) => s.pass.live || byId.has(s.pass.id))
    for (const s of kept) if (!s.pass.live) s.pass = byId.get(s.pass.id)! // live ones aren't in the library
    if (current) current.pass = byId.get(current.pass.id) ?? current.pass // on air: finishes even if deleted
    this.slots = current ? [current, ...kept] : kept
    if (kept.length !== upcoming.length) this.rechain(1)
    this.fill()
    this.onChange()
  }

  // the real receiver's upcoming passes (re-predicted now and then): planned live slots it no
  // longer has go, unless already on their way. dropOnAir: that one too (the receiver stopped
  // answering), and a replay takes over from now; it's not kept as received.
  setLive(passes: Pass[], dropOnAir = false) {
    const now = Date.now()
    const byId = new Map(passes.map((p) => [p.id, p]))
    this.live = [...passes].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    const onAir = this.slots[0]
    this.slots = this.slots.filter(
      (s, i) => !s.pass.live || byId.has(s.pass.id) || (!dropOnAir && i === 0 && now >= s.approachAt),
    )
    this.rechain(this.slots[0] === onAir ? 1 : 0)
    this.fill()
    this.onChange()
  }

  // the real receiver's passes that go live, soonest first (the passes board shows the next one)
  get livePasses(): readonly Pass[] {
    return this.live
  }

  tick() {
    const now = Date.now()
    let changed = false
    while (this.slots.length && this.slots[0].end <= now) {
      this.history.unshift(this.slots.shift()!)
      changed = true
    }
    if (this.history.length > HISTORY) this.history.length = HISTORY
    const before = this.slots.length
    this.fill()
    if (changed || this.slots.length !== before) this.onChange()
  }

  skip() {
    if (!this.slots.length) return
    this.history.unshift(this.slots.shift()!)
    this.rechain(0)
    this.fill()
    this.onChange()
  }

  restart() {
    if (!this.slots.length) return
    this.rechain(0)
    this.onChange()
  }

  // play this pass right after the one on air
  queue(passId: number) {
    const pass = this.passes.find((p) => p.id === passId)
    if (!pass) return
    const at = this.slots.length ? 1 : 0
    this.slots.splice(at, 0, this.makeSlot(pass, 0))
    this.slots.length = Math.min(this.slots.length, 1 + this.cfg.upcoming)
    this.rechain(at)
    this.fill()
    this.onChange()
  }

  // this pass at the end of the plan, after the upcoming ones: the passes board shows it arriving
  // (a finished real pass, just imported). The plan is one longer until the one on air ends.
  append(passId: number) {
    const pass = this.passes.find((p) => p.id === passId)
    if (!pass) return
    this.slots.push(this.makeSlot(pass, this.slots.at(-1)?.end ?? Date.now()))
    this.fill()
    this.onChange()
  }

  private fill() {
    this.fillReplays()
    // the next live pass joins once the plan reaches its approach (or straight away when there is
    // nothing to replay)
    const next = this.nextLive()
    if (next) {
      const last = this.slots.at(-1)
      if (!last || last.end > this.liveStart(next) || !this.passes.length) {
        const at = this.slots.findIndex((s, i) => i > 0 && s.start >= this.liveStart(next))
        const slot = this.makeSlot(next, last?.end ?? Date.now())
        if (at < 0) this.slots.push(slot)
        else this.slots.splice(at, 0, slot)
        this.fitLive()
        this.fillReplays()
      }
    }
  }

  private fillReplays() {
    while (this.slots.length < 1 + this.cfg.upcoming) {
      const pass = this.pick()
      if (!pass) return
      const start = this.slots.length ? this.slots[this.slots.length - 1].end : Date.now()
      this.slots.push(this.makeSlot(pass, start))
    }
  }

  // the soonest live pass not yet planned, on air or over
  private nextLive(): Pass | null {
    const now = Date.now()
    const seen = new Set([...this.slots, ...this.history].map((s) => s.pass.id))
    return this.live.find((p) => !seen.has(p.id) && Date.parse(p.end ?? p.start) > now) ?? null
  }

  // when the screens switch to a live pass: its AOS, or a moment after (receiver.joinDelay)
  private liveStart(pass: Pass) {
    const aos = Date.parse(pass.start)
    const los = Date.parse(pass.end ?? pass.start)
    return Math.min(los, aos + (this.cfg.receiver?.joinDelay ?? 0) * 1000)
  }

  // re-time the slots from `from` on, back to back (from 0: starting now)
  private rechain(from: number) {
    if (from >= this.slots.length) return
    let t = from === 0 ? Date.now() : this.slots[from - 1].end
    for (let i = from; i < this.slots.length; i++) {
      this.slots[i] = this.makeSlot(this.slots[i].pass, t, this.slots[i].id)
      t = this.slots[i].end
    }
    this.fitLive()
  }

  // Live slots at their real times: the replay on air then is cut there, replays planned to start
  // after its AOS move to after it (a pass just imported isn't lost), and the ones after follow on
  // from the live slot's end. A replay cut for a live slot that has gone since plays out whole again.
  private fitLive() {
    const out: Slot[] = []
    const depart = this.cfg.departSeconds * 1000
    for (const planned of this.slots) {
      let s = !planned.pass.live && planned.end < planned.los + depart ? { ...planned, end: planned.los + depart } : planned
      const prev = out.at(-1)
      if (prev && s.pass.live) {
        const at = this.liveStart(s.pass)
        const moved: Slot[] = [] // replays that would start after its AOS: after it instead
        while (out.length > 1 && !out.at(-1)!.pass.live && out.at(-1)!.start >= at) moved.unshift(out.pop()!)
        const before = out.at(-1)!
        if (before.end > at) out[out.length - 1] = { ...before, end: Math.max(before.start, at) } // cut
        out.push(this.makeSlot(s.pass, out.at(-1)!.end, s.id))
        for (const m of moved) out.push(this.makeSlot(m.pass, out.at(-1)!.end, m.id))
        continue
      } else if (prev && s.start !== prev.end) {
        s = this.makeSlot(s.pass, prev.end, s.id)
      }
      out.push(s)
    }
    this.slots = out
  }

  // ms of each phase: waiting, approach, reception, after LOS
  private lengths(pass: Pass) {
    const c = this.cfg
    return [c.waitSeconds * 1000, c.approachSeconds * 1000, (receptionSeconds(pass) / c.speed) * 1000, c.departSeconds * 1000]
  }

  private makeSlot(pass: Pass, start: number, id = this.nextId++): Slot {
    if (pass.live) {
      // its real AOS and LOS, from `start` (the slot before's end, normally its AOS: no approach;
      // with nothing to replay before it, waiting and its approach)
      const aos = Date.parse(pass.start)
      const los = Math.max(aos, Date.parse(pass.end ?? pass.start))
      const approachAt = Math.min(aos, Math.max(start, aos - this.cfg.approachSeconds * 1000))
      return { id, pass, start, approachAt, aos, los, end: los + this.cfg.departSeconds * 1000 }
    }
    const [wait, approach, reception, depart] = this.lengths(pass)
    const approachAt = start + wait
    const aos = approachAt + approach
    const los = aos + reception
    return { id, pass, start, approachAt, aos, los, end: los + depart }
  }

  // the slot on air with the current lengths, `now` at the same fraction of its phase
  private retimeOnAir(s: Slot, now: number): Slot {
    const old = [s.start, s.approachAt, s.aos, s.los, s.end]
    const lengths = this.lengths(s.pass)
    let i = 0
    while (i < 3 && now >= old[i + 1]) i++
    const span = old[i + 1] - old[i]
    const f = span > 0 ? Math.min(1, Math.max(0, (now - old[i]) / span)) : 0
    const b = [0, 0, 0, 0, 0]
    b[i] = now - f * lengths[i]
    for (let k = i + 1; k < 5; k++) b[k] = b[k - 1] + lengths[k - 1]
    for (let k = i - 1; k >= 0; k--) b[k] = b[k + 1] - lengths[k]
    return { ...s, start: b[0], approachAt: b[1], aos: b[2], los: b[3], end: b[4] }
  }

  private pick(): Pass | null {
    const wanted = this.cfg.satellites
    const pool = this.passes.filter((p) => !wanted.length || wanted.includes(p.satellite))
    if (!pool.length) return null
    const last = this.slots.at(-1)?.pass ?? this.history[0]?.pass
    let pass: Pass
    if (this.cfg.order === 'chronological') {
      const i = last ? pool.findIndex((p) => p.start > last.start) : 0
      pass = pool[i < 0 ? 0 : i]
    } else {
      // shuffle: none of the recent picks, and when possible another station and satellite than the last
      const n = Math.min(pool.length - 1, 30)
      const recent = new Set(n > 0 ? this.picked.slice(-n) : [])
      let options = pool.filter((p) => !recent.has(p.id))
      const prefer = (keep: (p: Pass) => boolean) => {
        const o = options.filter(keep)
        if (o.length) options = o
      }
      if (last) {
        prefer((p) => p.station_name !== last.station_name)
        prefer((p) => p.satellite !== last.satellite)
      }
      pass = options[Math.floor(Math.random() * options.length)]
    }
    this.picked.push(pass.id)
    if (this.picked.length > 200) this.picked.shift()
    return pass
  }
}
