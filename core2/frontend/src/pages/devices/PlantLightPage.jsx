import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// plant light — esp32C3_plant_light, a carriage on a rail pulled by a DC
// motor (L298N), with an optical endstop at each end. It runs to an end
// (MOVE) or back and forth between them (CYCLE).
//
// Every setting lives on the device (flash) and comes back retained on
// .../config as node.config. The page sends changes with CONFIG; any command
// body can carry settings too.
//
//   MOVE   {to: "left"|"right"}     CYCLE {to?}     STOP {}     RESET {}
//   CONFIG {speed, min, pause_l, pause_r, cycles, ramp, timeout,
//           rev, inv, auto, len, prof: [32 x 0..255], pts: [[t, v]..]}
//
// The speed profile is how fast to go at each point of the rail (left ->
// right, both directions), as a % of `speed`. The device estimates where
// the carriage is from speed x time and re-measures the rail (`len`, in
// full-speed ms) on every full end-to-end trip; until it has, it runs flat.
//
// See the command block in esp32C3_plant_light.ino.

const PROFILE_N = 32;   // firmware samples
const MAX_POINTS = 16;  // firmware limit
const W = 1000;
const H = 200;
const LANE_PX = 160;
const HIT_POINT_PX = 12;
const HIT_LINE_PX = 12;
const GREEN = '#22c55e';
const AMBER = '#f59e0b';
const RED = '#ef4444';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0', alignItems: 'center' };
const ON = { outline: '2px solid currentColor', opacity: 1 };

const DEFAULTS = {
  speed: 180, min: 60, pause_l: 2000, pause_r: 2000, cycles: 0, ramp: 500,
  timeout: 60000, rev: false, inv: false, auto: false, len: 0,
};

// ── profile math ──────────────────────────────────────────────────────────
// points: [{t: 0..999, v: 0..255}] sorted by t. Returns f(x), x = 0..1 left
// to right. Monotone cubic, so it never overshoots a point; flat before the
// first point and after the last.
function makeProfile(points) {
  const n = points.length;
  if (n === 0) return () => 255;
  if (n === 1) return () => points[0].v;

  const P = points.map((p) => ({ x: p.t / 999, y: p.v }));
  const h = [];
  const d = [];
  for (let k = 0; k < n - 1; k++) {
    h[k] = P[k + 1].x - P[k].x;
    d[k] = h[k] > 0 ? (P[k + 1].y - P[k].y) / h[k] : 0;
  }
  const m = [d[0]];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  m[n - 1] = d[n - 2];

  return (x) => {
    if (x <= P[0].x) return P[0].y;
    if (x >= P[n - 1].x) return P[n - 1].y;
    let k = 0;
    while (k < n - 2 && x >= P[k + 1].x) k++;
    const a = P[k];
    const b = P[k + 1];
    const hk = h[k];
    if (hk <= 0) return a.y;
    const s = (x - a.x) / hk;
    const s2 = s * s;
    const s3 = s2 * s;
    const y =
      (2 * s3 - 3 * s2 + 1) * a.y +
      (s3 - 2 * s2 + s) * hk * m[k] +
      (-2 * s3 + 3 * s2) * b.y +
      (s3 - s2) * hk * m[k + 1];
    return Math.max(0, Math.min(255, y));
  };
}

const toSamples = (points) => {
  const f = makeProfile(points);
  return Array.from({ length: PROFILE_N }, (_, i) => Math.round(f(i / (PROFILE_N - 1))));
};

// linear lookup in the device's samples, like profileAt() in the firmware
function sampleAt(samples, x) {
  const p = Math.max(0, Math.min(1, x)) * (samples.length - 1);
  const i = Math.min(Math.floor(p), samples.length - 2);
  return samples[i] + (samples[i + 1] - samples[i]) * (p - i);
}

// Seconds for one end-to-end trip, from the learned length. Same speed
// model as the firmware (speed x profile, at least 1), ignoring the ramp.
function tripSeconds(len, speed, samples) {
  if (!len || !speed) return null;
  const N = 200;
  let ms = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.max((speed * sampleAt(samples, (i + 0.5) / N)) / 255, 1) / 255;
    ms += len / N / v;
  }
  return ms / 1000;
}

const pt = (x, v) => ({ t: Math.round(x * 999), v });

const PRESETS = {
  Flat: () => [pt(0, 255), pt(1, 255)],
  'Ease ends': () => [pt(0, 70), pt(0.15, 255), pt(0.85, 255), pt(1, 70)],
  'Linger middle': () => [pt(0, 255), pt(0.32, 255), pt(0.5, 50), pt(0.68, 255), pt(1, 255)],
  'Slow left': () => [pt(0, 80), pt(0.42, 80), pt(0.58, 255), pt(1, 255)],
  'Slow right': () => [pt(0, 255), pt(0.42, 255), pt(0.58, 80), pt(1, 80)],
  Wave: () => [pt(0, 255), pt(0.25, 80), pt(0.5, 255), pt(0.75, 80), pt(1, 255)],
};

const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const samePoints = (a, b) => a.length === b.length && a.every((p, i) => p.t === b[i].t && p.v === b[i].v);

// Points from the device, or one every 4th sample when it has none.
function pointsFromConfig(config) {
  if (Array.isArray(config.pts) && config.pts.length > 0) {
    return config.pts.map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  }
  if (!Array.isArray(config.prof) || config.prof.length < 2) return null;
  const n = config.prof.length;
  const out = [];
  for (let i = 0; i < n; i += 4) out.push({ t: Math.round((i / (n - 1)) * 999), v: config.prof[i] });
  if (out[out.length - 1].t !== 999) out.push({ t: 999, v: config.prof[n - 1] });
  return out;
}

const polyline = (f, steps = 250) => {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(`${(i / steps) * W},${H - (f(i / steps) / 255) * H}`);
  return pts.join(' ');
};

const samplesPolyline = (s) => s.map((v, i) => `${(i / (s.length - 1)) * W},${H - (v / 255) * H}`).join(' ');

// ── the rail, live ────────────────────────────────────────────────────────
function Rail({ pos, endL, endR, dir, state }) {
  const known = typeof pos === 'number' && pos >= 0;
  const moving = state === 'moving';
  const End = ({ on, side }) => (
    <div
      title={on ? 'endstop: carriage here' : 'endstop: clear'}
      style={{
        position: 'absolute', top: '50%', [side]: -2, width: 14, height: 28, marginTop: -14,
        borderRadius: 4, background: on ? AMBER : 'var(--code-bg)', border: `2px solid ${on ? AMBER : 'var(--border)'}`,
        boxShadow: on ? `0 0 10px ${AMBER}` : 'none',
      }}
    />
  );
  return (
    <div style={{ position: 'relative', height: 44, margin: '0 7px' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 4, marginTop: -2, background: 'var(--border)', borderRadius: 2 }} />
      <End on={endL} side="left" />
      <End on={endR} side="right" />
      <div
        style={{
          position: 'absolute', top: '50%', left: `${known ? pos / 10 : 50}%`,
          width: 36, height: 22, marginLeft: -18, marginTop: -11, borderRadius: 5,
          background: known ? GREEN : 'transparent', border: `2px ${known ? 'solid' : 'dashed'} ${GREEN}`,
          color: 'var(--bg)', fontSize: 13, lineHeight: '18px', textAlign: 'center', fontWeight: 700,
          transition: moving ? 'left 1s linear' : 'left 0.3s ease-out',
        }}
      >
        {known ? (dir > 0 ? '▶' : dir < 0 ? '◀' : '') : <span style={{ color: GREEN }}>?</span>}
      </div>
    </div>
  );
}

// ── speed profile editor ──────────────────────────────────────────────────
// Drag a point to move it, drag from the line to add one, double-click or
// right-click a point to remove it.
function ProfileEditor({ points, onChange, saved, pos }) {
  const boxRef = useRef(null);
  const drag = useRef(null);
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  const f = makeProfile(points);

  const locate = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
      w: r.width,
      h: r.height,
    };
  };

  const hitPoint = ({ x, y, w, h }) => {
    let best = -1;
    let bestDist = HIT_POINT_PX;
    points.forEach((p, i) => {
      const dist = Math.hypot((p.t / 999) * w - x, (1 - p.v / 255) * h - y);
      if (dist <= bestDist) { best = i; bestDist = dist; }
    });
    return best;
  };

  const onLine = ({ x, y, w, h }) => Math.abs((1 - f(x / w) / 255) * h - y) <= HIT_LINE_PX;
  const remove = (i) => points.length > 1 && onChange(points.filter((_, j) => j !== i));

  const moveTo = (i, { x, y, w, h }) => {
    const lo = i > 0 ? points[i - 1].t + 1 : 0;
    const hi = i < points.length - 1 ? points[i + 1].t - 1 : 999;
    const t = Math.max(lo, Math.min(hi, Math.round((x / w) * 999)));
    const v = Math.max(0, Math.min(255, Math.round((1 - y / h) * 255)));
    onChange(points.map((p, j) => (j === i ? { t, v } : p)));
  };

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    const at = locate(e);
    const i = hitPoint(at);
    if (i >= 0) {
      drag.current = i;
    } else if (onLine(at) && points.length < MAX_POINTS) {
      const t = Math.round((at.x / at.w) * 999);
      if (points.some((p) => p.t === t)) return;
      const next = [...points, { t, v: Math.round(f(t / 999)) }].sort((a, b) => a.t - b.t);
      drag.current = next.findIndex((p) => p.t === t);
      onChange(next);
    } else {
      return;
    }
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const at = locate(e);
    if (drag.current !== null) { moveTo(drag.current, at); return; }
    setHover(hitPoint(at) >= 0 ? 'point' : onLine(at) ? 'line' : null);
  };

  const endDrag = () => { drag.current = null; setDragging(false); };
  const removeAt = (e) => { e.preventDefault(); const i = hitPoint(locate(e)); if (i >= 0) remove(i); };

  const cursor = dragging ? 'grabbing' : hover === 'point' ? 'grab' : hover === 'line' ? 'copy' : 'default';
  const line = polyline(f);
  const drawn = toSamples(points);

  return (
    <div
      ref={boxRef}
      style={{
        position: 'relative', height: LANE_PX, border: '1px solid var(--border)', borderRadius: 6,
        background: 'var(--code-bg)', touchAction: 'none', userSelect: 'none', cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => drag.current === null && setHover(null)}
      onContextMenu={removeAt}
      onDoubleClick={removeAt}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
        ))}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={`v${g}`} x1={W * g} x2={W * g} y1={0} y2={H} stroke="var(--border)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={GREEN} fillOpacity={0.2} />
        <polyline points={line} fill="none" stroke={GREEN} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {saved && !sameArr(saved, drawn) && (
          <polyline points={samplesPolyline(saved)} fill="none" stroke="var(--text)" strokeWidth={1}
            strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        {typeof pos === 'number' && pos >= 0 && (
          <line x1={(pos / 1000) * W} x2={(pos / 1000) * W} y1={0} y2={H} stroke="var(--text-h)" strokeWidth={2}
            vectorEffect="non-scaling-stroke" style={{ transition: 'all 1s linear' }} />
        )}
      </svg>
      <span className="dim" style={{ position: 'absolute', top: 4, left: 8, fontSize: 12 }}>100%</span>
      <span className="dim" style={{ position: 'absolute', bottom: 4, left: 8, fontSize: 12 }}>0%</span>
      {points.map((p, i) => (
        <div key={i} style={{
          position: 'absolute', left: `${(p.t / 999) * 100}%`, top: `${(1 - p.v / 255) * 100}%`,
          width: 12, height: 12, marginLeft: -6, marginTop: -6, borderRadius: '50%', background: GREEN,
          border: '2px solid var(--bg)', boxShadow: '0 0 0 1px var(--text-h)', pointerEvents: 'none',
        }} />
      ))}
    </div>
  );
}

// ── inputs ────────────────────────────────────────────────────────────────
function Slider({ id, label, value, readout, min, max, step, onChange, onCommit }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '96px 72px minmax(0, 1fr)', alignItems: 'center', gap: 12, margin: '8px 0' }}>
      <label htmlFor={id}>{label}</label>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', opacity: 0.75 }}>{readout}</span>
      <input id={id} type="range" style={{ width: '100%', minWidth: 0 }} min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit} onTouchEnd={onCommit} onKeyUp={onCommit} />
    </div>
  );
}

// Number box that sends on Enter or when you leave it. `scale` converts
// between what you type (e.g. seconds) and what the device stores (ms).
function NumberField({ id, label, value, unit, min, max, step = 1, scale = 1, onCommit, hint }) {
  const [text, setText] = useState(String(value / scale));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value / scale)); }, [value, scale]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || Number.isNaN(n)) { setText(String(value / scale)); return; }
    const v = Math.round(Math.max(min, Math.min(max, n)) * scale);
    setText(String(v / scale));
    if (v !== value) onCommit(v);
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '96px auto minmax(0, 1fr)', alignItems: 'center', gap: 12, margin: '8px 0' }}>
      <label htmlFor={id}>{label}</label>
      <span style={{ whiteSpace: 'nowrap' }}>
        <input id={id} type="number" min={min} max={max} step={step} value={text} style={{ width: 80 }}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; commit(); }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} /> {unit}
      </span>
      <span className="dim">{hint}</span>
    </div>
  );
}

function Check({ label, checked, onChange, hint }) {
  return (
    <div style={{ margin: '8px 0' }}>
      <label style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
      {hint && <div className="dim" style={{ marginLeft: 24 }}>{hint}</div>}
    </div>
  );
}

const fmtSecs = (s) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);

// ── page ──────────────────────────────────────────────────────────────────
export default function PlantLightPage({ node, sendCommand, error }) {
  const id = node.device_id;
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetry = node.telemetry || {};
  const config = node.config || {};
  const hasConfig = Array.isArray(config.prof);
  const send = (cmd, params = {}) => sendCommand(id, cmd, params);

  // Settings: show the device's value, or your edit until the device echoes
  // it back on its config topic.
  const [edits, setEdits] = useState({});
  const val = (k) => (k in edits ? edits[k] : k in config ? config[k] : DEFAULTS[k]);
  const change = (k, v) => setEdits((e) => ({ ...e, [k]: v }));
  const commit = (k, v = val(k)) => {
    change(k, v);
    send('CONFIG', { [k]: v });
  };
  const configKey = JSON.stringify(config);
  useEffect(() => {
    setEdits((e) => {
      const next = { ...e };
      Object.keys(next).forEach((k) => { if (config[k] === next[k]) delete next[k]; });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  // Profile draft follows the device until you edit it.
  const savedPoints = hasConfig ? pointsFromConfig(config) : null;
  const [draft, setDraft] = useState(() => savedPoints || PRESETS.Flat());
  const [dirty, setDirty] = useState(false);
  const savedKey = JSON.stringify(savedPoints);
  useEffect(() => {
    if (!dirty && savedPoints) setDraft(savedPoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const editProfile = (p) => { setDraft(p); setDirty(true); };

  const drawn = toSamples(draft);
  const profileSaved = hasConfig && sameArr(config.prof, drawn) && savedPoints && samePoints(savedPoints, draft);
  const saveProfile = () => {
    send('CONFIG', { prof: drawn, pts: draft.map((p) => [p.t, p.v]) });
    setDirty(false);
  };
  const revertProfile = () => { if (savedPoints) setDraft(savedPoints); setDirty(false); };

  const state = telemetry.state;
  const cycling = telemetry.cyc === 1;
  const pos = node.online ? telemetry.pos : undefined;
  const len = val('len');
  const trip = tripSeconds(len, val('speed'), drawn);
  const err = telemetry.err;

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Plant light <span className="device-id">{id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>State: <b>{state ? `${state}${cycling ? ' (cycling)' : ''}` : '-'}</b></span>
        <span>Trips: <b>{telemetry.trips ?? '-'}</b></span>
        <span>Duty: <b>{telemetry.duty ?? '-'}</b></span>
      </div>

      <section className="card">
        <h3>Rail</h3>
        <Rail pos={pos} endL={telemetry.end_l === 1} endR={telemetry.end_r === 1} dir={telemetry.dir} state={state} />
        <div style={{ display: 'flex', justifyContent: 'space-between' }} className="dim">
          <span>Left end</span>
          <span>{typeof pos === 'number' && pos < 0 ? 'position unknown until it reaches an end' : ''}</span>
          <span>Right end</span>
        </div>
        {state === 'fault' && err && <div className="error-banner" style={{ marginTop: 8 }}>Stopped: {err}</div>}
        <div style={ROW}>
          <button className="jog-btn" style={state === 'moving' && !cycling && telemetry.dir < 0 ? ON : null}
            onClick={() => send('MOVE', { to: 'left' })}>◀ Left</button>
          <button className="jog-btn halt-btn" onClick={() => send('STOP')}>Stop</button>
          <button className="jog-btn" style={state === 'moving' && !cycling && telemetry.dir > 0 ? ON : null}
            onClick={() => send('MOVE', { to: 'right' })}>Right ▶</button>
          <button className="jog-btn" style={cycling ? ON : null} onClick={() => send('CYCLE')}>
            {cycling ? 'Cycling…' : 'Cycle ⇄'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Speed along the rail</h3>
        <p className="dim">
          How fast the carriage goes at each point of the rail, as a % of the speed below — the
          same shape both ways. Drag a point to move it, drag from the line to add one,
          double-click or right-click a point to remove it. The dashed line is what's on the
          device, when it differs from yours.
        </p>
        <div style={ROW}>
          <span>Presets:</span>
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className="jog-btn" onClick={() => editProfile(PRESETS[name]())}>{name}</button>
          ))}
        </div>
        <ProfileEditor points={draft} onChange={editProfile} saved={hasConfig ? config.prof : null} pos={pos} />
        <div style={{ display: 'flex', justifyContent: 'space-between', margin: '4px 7px 0' }} className="dim">
          <span>◀ left</span><span>right ▶</span>
        </div>
        <p className="dim">
          {len > 0
            ? `Rail measured. One trip takes about ${fmtSecs(trip)} with this profile.`
            : 'Rail not measured yet: the profile starts working after the first full end-to-end trip. Until then it runs flat at the speed below.'}
        </p>
        <div style={ROW}>
          <button className="jog-btn" style={profileSaved ? null : ON} disabled={profileSaved} onClick={saveProfile}>
            Save to device
          </button>
          <button className="jog-btn" disabled={!savedPoints || profileSaved} onClick={revertProfile}>
            Back to device's version
          </button>
          <span className="dim">
            {!hasConfig ? 'Device hasn\'t reported its settings yet.' : profileSaved ? 'Saved on device.' : 'Not saved yet.'}
          </span>
        </div>
      </section>

      <section className="card">
        <h3>Motor</h3>
        <p className="dim">Saved on the device as soon as you let go.</p>
        <Slider id="pl-speed" label="Speed" value={val('speed')} readout={`${Math.round((val('speed') / 255) * 100)}%`}
          min={0} max={255} step={1} onChange={(v) => change('speed', v)} onCommit={() => commit('speed')} />
        <Slider id="pl-min" label="Min duty" value={val('min')} readout={val('min')}
          min={0} max={200} step={1} onChange={(v) => change('min', v)} onCommit={() => commit('min')} />
        <p className="dim">
          Min duty: the lowest power the motor ever gets while moving. Raise it if it hums
          without turning at slow parts of the profile.
        </p>
        <Slider id="pl-ramp" label="Soft start" value={val('ramp')} readout={`${(val('ramp') / 1000).toFixed(1)} s`}
          min={0} max={5000} step={100} onChange={(v) => change('ramp', v)} onCommit={() => commit('ramp')} />
        <NumberField id="pl-timeout" label="Timeout" value={val('timeout')} unit="s" min={0} max={3600} scale={1000}
          onCommit={(v) => commit('timeout', v)}
          hint="Stops with a fault if no endstop shows up in this long. 0 = never." />
      </section>

      <section className="card">
        <h3>Cycle</h3>
        <NumberField id="pl-pause-l" label="Wait left" value={val('pause_l')} unit="s" min={0} max={3600} step={0.5} scale={1000}
          onCommit={(v) => commit('pause_l', v)} hint="How long it stays at the left end." />
        <NumberField id="pl-pause-r" label="Wait right" value={val('pause_r')} unit="s" min={0} max={3600} step={0.5} scale={1000}
          onCommit={(v) => commit('pause_r', v)} hint="How long it stays at the right end." />
        <NumberField id="pl-cycles" label="Round trips" value={val('cycles')} unit="" min={0} max={65535}
          onCommit={(v) => commit('cycles', v)} hint="0 = forever." />
        <Check label="Start cycling on power-up" checked={val('auto')} onChange={(v) => commit('auto', v)} />
        <div style={ROW}>
          <button className="jog-btn" style={cycling ? ON : null} onClick={() => send('CYCLE', { to: 'left' })}>Cycle, left first</button>
          <button className="jog-btn" style={cycling ? ON : null} onClick={() => send('CYCLE', { to: 'right' })}>Cycle, right first</button>
        </div>
      </section>

      <section className="card">
        <h3>Hardware</h3>
        <Check label="Reverse motor" checked={val('rev')} onChange={(v) => commit('rev', v)}
          hint={'Tick if "Right" moves it left. If this is wrong it stops with a "wrong way" fault.'} />
        <Check label="Endstops active LOW" checked={val('inv')} onChange={(v) => commit('inv', v)}
          hint="Only for sensors that read LOW when blocked. Careful: a disconnected sensor then reads as clear, and the motor can run into the end." />
        <div style={ROW}>
          <span>Rail length: <b>{len > 0 ? `${(len / 1000).toFixed(1)} s at full speed` : 'not measured'}</b></span>
          <button className="jog-btn" disabled={!len} onClick={() => commit('len', 0)}>Forget</button>
        </div>
        <p className="dim">Re-measured on every full end-to-end trip. Forget it if you change the rail or the motor.</p>
        <div style={ROW}>
          <button className="jog-btn halt-btn"
            onClick={() => window.confirm('Put every setting (and the profile) back to defaults?') && send('RESET')}>
            Reset all settings
          </button>
        </div>
      </section>

      <CommandPanel deviceId={id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
