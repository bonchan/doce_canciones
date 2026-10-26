import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// breathe — esp32C3_breathe, two one-way DC motors on an L298N blowing into
// the same funnel: one inhales, the other exhales. A breath is two curves
// (one per motor) looped over `period` ms.
//
// Each curve is edited here as a few control points joined by a smooth line
// (monotone cubic, so it never overshoots past a point: flat stays flat, a
// peak is where you put it). On save the page samples that line into
// SAMPLES speeds (0..255) for the device to play, and sends the points along
// so the page can reopen them exactly; the device stores both in flash and
// publishes them (retained) on .../config, which shows up as node.config.
//
//   CURVE   {period, in: [..], out: [..], pin: [[t,v]..], pout: [[t,v]..]}
//           t = 0..999 (thousandths of the breath), v = 0..255
//   PAUSE / RESUME
//   RATE  {value}  0.1..10   time multiplier
//   DEPTH {value}  0..1      speed multiplier
//   MIN   {value}  0..254    duty below which the motors stall
//
// See the command block in esp32C3_breathe.ino.

const SAMPLES = 64;
const MAX_POINTS = 32;  // firmware limit per curve
const W = 1000;         // viewBox width
const H = 200;          // viewBox height per lane
const LANE_PX = 170;    // lane height on screen
const HIT_POINT_PX = 12;
const HIT_LINE_PX = 12;
const INHALE = '#3b82f6';
const EXHALE = '#f97316';
const DELETE = '#ef4444';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0', alignItems: 'center' };
const ON = { outline: '2px solid currentColor', opacity: 1 };

// ── curve math ────────────────────────────────────────────────────────────
// points: [{t: 0..999, v: 0..255}] sorted by t. Returns f(x) for x = 0..1
// through the breath. The curve loops: after the last point it heads back to
// the first one. Monotone cubic (Fritsch–Butland tangents).
function makeCurve(points) {
  const n = points.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => points[0].v;

  const P = points.map((p) => ({ x: p.t / 1000, y: p.v }));
  // two wrapped copies on each side, so every real segment has neighbours
  const E = [
    ...P.slice(-2).map((p) => ({ x: p.x - 1, y: p.y })),
    ...P,
    ...P.slice(0, 2).map((p) => ({ x: p.x + 1, y: p.y })),
  ];
  const h = [];
  const d = [];
  for (let k = 0; k < E.length - 1; k++) {
    h[k] = E[k + 1].x - E[k].x;
    d[k] = h[k] > 0 ? (E[k + 1].y - E[k].y) / h[k] : 0;
  }
  const m = [];
  for (let k = 1; k < E.length - 1; k++) {
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }

  return (x) => {
    let k = 1;
    while (k < E.length - 3 && x >= E[k + 1].x) k++;
    const a = E[k];
    const b = E[k + 1];
    const hk = b.x - a.x;
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

const toSamples = (points, n = SAMPLES) => {
  const f = makeCurve(points);
  return Array.from({ length: n }, (_, i) => Math.round(f(i / n)));
};

const pt = (t, v) => ({ t: Math.round(t * 1000), v });

const PRESETS = {
  Calm: () => ({ period: 8000, pin: [pt(0, 0), pt(0.2, 200), pt(0.4, 0)], pout: [pt(0.5, 0), pt(0.7, 180), pt(0.9, 0)] }),
  Deep: () => ({ period: 12000, pin: [pt(0, 0), pt(0.22, 255), pt(0.45, 0)], pout: [pt(0.5, 0), pt(0.72, 230), pt(0.95, 0)] }),
  Panting: () => ({ period: 1500, pin: [pt(0, 0), pt(0.22, 220), pt(0.45, 0)], pout: [pt(0.5, 0), pt(0.72, 220), pt(0.95, 0)] }),
  Sigh: () => ({
    period: 10000,
    pin: [pt(0, 0), pt(0.12, 200), pt(0.24, 120), pt(0.31, 170), pt(0.4, 0)],
    pout: [pt(0.45, 0), pt(0.7, 160), pt(0.95, 0)],
  }),
  Hold: () => ({ period: 10000, pin: [pt(0, 0), pt(0.15, 200), pt(0.3, 0)], pout: [pt(0.6, 0), pt(0.75, 200), pt(0.9, 0)] }),
};

const sameCurve = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const samePoints = (a, b) => a.length === b.length && a.every((p, i) => p.t === b[i].t && p.v === b[i].v);

// Points from the device, or — for curves saved without points (older
// firmware, or samples sent by hand) — one point every 8th sample.
function pointsFromConfig(raw, samples) {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  }
  const n = samples.length;
  const step = Math.max(1, Math.round(n / 8));
  const out = [];
  for (let i = 0; i < n; i += step) out.push({ t: Math.round((i / n) * 1000), v: samples[i] });
  return out;
}

function fromConfig(config) {
  if (!config || !Array.isArray(config.in) || !Array.isArray(config.out)) return null;
  return {
    period: config.period || 8000,
    in: config.in,
    out: config.out,
    pin: pointsFromConfig(config.pin, config.in),
    pout: pointsFromConfig(config.pout, config.out),
  };
}

// polyline (viewBox units) for a looping list of samples, closing back to
// sample 0 at the right edge like the device does
function samplePolyline(v) {
  const n = v.length;
  const pts = v.map((x, i) => `${(i / n) * W},${H - (x / 255) * H}`);
  pts.push(`${W},${H - (v[0] / 255) * H}`);
  return pts.join(' ');
}

function curvePolyline(f, steps = 250) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(`${(i / steps) * W},${H - (f(i / steps) / 255) * H}`);
  return pts.join(' ');
}

// ── one motor's lane ──────────────────────────────────────────────────────
// Drag a point to move it. Drag from the line to add a point there. Click a
// point in delete mode (or right-click it any time) to remove it.
function Lane({ label, color, points, onChange, saved, phase, period, live, deleteMode }) {
  const boxRef = useRef(null);
  const drag = useRef(null);  // index of the point being dragged
  const [hover, setHover] = useState(null);  // 'point' | 'line' | null
  const [dragging, setDragging] = useState(false);

  const f = makeCurve(points);

  const locate = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    return { x, y, w: r.width, h: r.height };
  };

  const hitPoint = ({ x, y, w, h }) => {
    let best = -1;
    let bestDist = HIT_POINT_PX;
    points.forEach((p, i) => {
      const dist = Math.hypot((p.t / 1000) * w - x, (1 - p.v / 255) * h - y);
      if (dist <= bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    return best;
  };

  const onLine = ({ x, y, w, h }) => Math.abs((1 - f(x / w) / 255) * h - y) <= HIT_LINE_PX;

  const remove = (i) => onChange(points.filter((_, j) => j !== i));

  // Keep the point between its neighbours so the order (and the index being
  // dragged) never changes under the pointer.
  const moveTo = (i, { x, y, w, h }) => {
    const lo = i > 0 ? points[i - 1].t + 1 : 0;
    const hi = i < points.length - 1 ? points[i + 1].t - 1 : 999;
    const t = Math.max(lo, Math.min(hi, Math.round((x / w) * 1000)));
    const v = Math.max(0, Math.min(255, Math.round((1 - y / h) * 255)));
    onChange(points.map((p, j) => (j === i ? { t, v } : p)));
  };

  const onPointerDown = (e) => {
    if (e.button === 2) return;  // right-click is handled by onContextMenu
    const at = locate(e);
    const i = hitPoint(at);

    if (deleteMode) {
      if (i >= 0) remove(i);
      return;
    }
    if (i >= 0) {
      drag.current = i;  // dragging an existing point never creates one
    } else if (onLine(at) && points.length < MAX_POINTS) {
      const t = Math.min(999, Math.round((at.x / at.w) * 1000));
      if (points.some((p) => p.t === t)) return;
      const v = Math.round(f(t / 1000));
      const next = [...points, { t, v }].sort((a, b) => a.t - b.t);
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
    if (drag.current !== null) {
      moveTo(drag.current, at);
      return;
    }
    setHover(hitPoint(at) >= 0 ? 'point' : !deleteMode && onLine(at) ? 'line' : null);
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  let cursor = 'default';
  if (deleteMode) cursor = hover === 'point' ? 'pointer' : 'default';
  else if (dragging) cursor = 'grabbing';
  else if (hover === 'point') cursor = 'grab';
  else if (hover === 'line') cursor = 'copy';

  const line = curvePolyline(f);
  const drawn = toSamples(points);
  const seconds = period / 1000;
  const tickEvery = seconds > 20 ? 5 : seconds > 6 ? 1 : 0.5;
  const ticks = [];
  for (let s = tickEvery; s < seconds - 1e-9; s += tickEvery) ticks.push(s);

  return (
    <div style={{ margin: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style={{ color }}>{label}</b>
        <span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {points.length} points{typeof live === 'number' ? ` · duty now ${live}` : ''}
        </span>
      </div>
      <div
        ref={boxRef}
        style={{
          position: 'relative',
          height: LANE_PX,
          border: `1px solid ${deleteMode ? DELETE : 'var(--border)'}`,
          borderRadius: 6,
          background: 'var(--code-bg)',
          touchAction: 'none',
          userSelect: 'none',
          cursor,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => drag.current === null && setHover(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          const i = hitPoint(locate(e));
          if (i >= 0) remove(i);
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
        >
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
          ))}
          {ticks.map((s) => (
            <line key={s} x1={(s / seconds) * W} x2={(s / seconds) * W} y1={0} y2={H}
              stroke="var(--border)" vectorEffect="non-scaling-stroke" />
          ))}
          <polygon points={`0,${H} ${line} ${W},${H}`} fill={color} fillOpacity={0.22} />
          <polyline points={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {saved && !sameCurve(saved, drawn) && (
            <polyline points={samplePolyline(saved)} fill="none" stroke="var(--text)"
              strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          )}
          {typeof phase === 'number' && (
            <line x1={phase * W} x2={phase * W} y1={0} y2={H} stroke="var(--text-h)" strokeWidth={2}
              vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* points as HTML so they stay round while the svg stretches */}
        {points.map((p, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${(p.t / 1000) * 100}%`,
              top: `${(1 - p.v / 255) * 100}%`,
              width: 12,
              height: 12,
              marginLeft: -6,
              marginTop: -6,
              borderRadius: '50%',
              background: deleteMode ? DELETE : color,
              border: '2px solid var(--bg)',
              boxShadow: '0 0 0 1px var(--text-h)',
              pointerEvents: 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Slider({ id, label, value, readout, min, max, step, onChange, onCommit }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '84px 64px minmax(0, 1fr)', alignItems: 'center', gap: 12, margin: '8px 0' }}>
      <label htmlFor={id}>{label}</label>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', opacity: 0.75 }}>{readout}</span>
      <input id={id} type="range" style={{ width: '100%', minWidth: 0 }} min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit} onTouchEnd={onCommit} onKeyUp={onCommit} />
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────
export default function BreathePage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetry = node.telemetry || {};
  const config = node.config || {};
  const saved = fromConfig(config);

  // The draft follows what's on the device until you edit it.
  const [draft, setDraft] = useState(() => saved || PRESETS.Calm());
  const [dirty, setDirty] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    if (!dirty && saved) setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const edit = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const [deleteMode, setDeleteMode] = useState(false);

  const drawnIn = toSamples(draft.pin);
  const drawnOut = toSamples(draft.pout);
  const matchesDevice =
    saved &&
    saved.period === draft.period &&
    sameCurve(saved.in, drawnIn) &&
    sameCurve(saved.out, drawnOut) &&
    samePoints(saved.pin, draft.pin) &&
    samePoints(saved.pout, draft.pout);

  const saveToDevice = () => {
    sendCommand(node.device_id, 'CURVE', {
      period: draft.period,
      in: drawnIn,
      out: drawnOut,
      pin: draft.pin.map((p) => [p.t, p.v]),
      pout: draft.pout.map((p) => [p.t, p.v]),
    });
    // shows "Not saved yet" until the device's retained config echoes it back
    setDirty(false);
  };

  const revert = () => {
    if (saved) setDraft(saved);
    setDirty(false);
  };

  // Playback settings: follow the device until touched.
  const [rate, setRate] = useState(1);
  const [depth, setDepth] = useState(1);
  const [minDuty, setMinDuty] = useState(70);
  const touched = useRef({});
  useEffect(() => {
    if (!touched.current.rate && typeof config.rate === 'number') setRate(Math.round(config.rate * 100) / 100);
    if (!touched.current.depth && typeof config.depth === 'number') setDepth(Math.round(config.depth * 100) / 100);
    if (!touched.current.min && typeof config.min === 'number') setMinDuty(config.min);
  }, [config.rate, config.depth, config.min]);

  // config is republished the moment PAUSE/RESUME lands; telemetry lags up to a second
  const running = typeof config.running === 'boolean' ? config.running : telemetry.running !== 0;

  // Playhead: telemetry only says where the breath is once a second, so
  // advance it locally between ticks.
  const [phase, setPhase] = useState(null);
  const tick = useRef({ t: null, at: 0 });
  useEffect(() => {
    if (typeof telemetry.t === 'number') tick.current = { t: telemetry.t, at: performance.now() };
  }, [telemetry.t, telemetry.millis]);
  const devicePeriod = (saved && saved.period) || draft.period;
  const deviceRate = typeof config.rate === 'number' ? config.rate : 1;
  useEffect(() => {
    let raf;
    const loop = () => {
      const { t, at } = tick.current;
      if (t === null || !node.online) setPhase(null);
      else {
        const ms = running ? t + (performance.now() - at) * deviceRate : t;
        setPhase((ms % devicePeriod) / devicePeriod);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [devicePeriod, deviceRate, running, node.online]);

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Breathe <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>State: <b>{saved ? (running ? 'breathing' : 'paused') : '-'}</b></span>
      </div>

      <section className="card">
        <h3>Breath</h3>
        <p className="dim">
          Each motor's speed over one breath; it loops. Higher = faster. Drag a
          point to move it, drag from the line to add one. Delete mode (or
          right-click a point) removes points. The dashed line is what's saved on
          the device, when it differs from yours.
        </p>

        <div style={ROW}>
          <span>Presets:</span>
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className="jog-btn" onClick={() => edit(PRESETS[name]())}>{name}</button>
          ))}
        </div>

        <div style={ROW}>
          <label htmlFor="breath-period">Breath length</label>
          <input
            id="breath-period"
            type="number"
            min={0.5}
            max={120}
            step={0.5}
            value={draft.period / 1000}
            onChange={(e) => {
              const s = Number(e.target.value);
              if (s >= 0.5 && s <= 120) edit({ period: Math.round(s * 1000) });
            }}
            style={{ width: 80 }}
          />
          <span>seconds</span>
          <button
            className="jog-btn"
            style={deleteMode ? { ...ON, color: DELETE } : null}
            onClick={() => setDeleteMode((d) => !d)}
          >
            {deleteMode ? 'Delete mode: on' : 'Delete mode'}
          </button>
        </div>

        <Lane label="Inhale" color={INHALE} points={draft.pin} onChange={(p) => edit({ pin: p })}
          saved={saved && saved.in} phase={phase} period={draft.period} live={telemetry.inhale} deleteMode={deleteMode} />
        <Lane label="Exhale" color={EXHALE} points={draft.pout} onChange={(p) => edit({ pout: p })}
          saved={saved && saved.out} phase={phase} period={draft.period} live={telemetry.exhale} deleteMode={deleteMode} />

        <div style={ROW}>
          <button className="jog-btn" onClick={() => edit({ pin: [] })}>Clear inhale</button>
          <button className="jog-btn" onClick={() => edit({ pout: [] })}>Clear exhale</button>
        </div>

        <div style={ROW}>
          <button className="jog-btn" style={matchesDevice ? null : ON} disabled={matchesDevice} onClick={saveToDevice}>
            Save to device
          </button>
          <button className="jog-btn" disabled={!saved || matchesDevice} onClick={revert}>
            Back to device's version
          </button>
          <span className="dim">
            {!saved ? 'Device hasn\'t reported its curves yet.' : matchesDevice ? 'Saved on device.' : 'Not saved yet.'}
          </span>
        </div>
      </section>

      <section className="card">
        <h3>Playback</h3>
        <p className="dim">These are saved on the device too, as soon as you let go of the slider.</p>
        <div style={ROW}>
          <button className="jog-btn" style={running ? ON : null} onClick={() => sendCommand(node.device_id, 'RESUME', {})}>
            Breathe
          </button>
          <button className="jog-btn halt-btn" style={!running ? ON : null} onClick={() => sendCommand(node.device_id, 'PAUSE', {})}>
            Pause
          </button>
        </div>
        <Slider id="breath-rate" label="Rate" value={rate} readout={`${rate.toFixed(2)}×`} min={0.1} max={4} step={0.05}
          onChange={(v) => { touched.current.rate = true; setRate(v); }}
          onCommit={() => sendCommand(node.device_id, 'RATE', { value: rate })} />
        <Slider id="breath-depth" label="Depth" value={depth} readout={`${Math.round(depth * 100)}%`} min={0} max={1} step={0.01}
          onChange={(v) => { touched.current.depth = true; setDepth(v); }}
          onCommit={() => sendCommand(node.device_id, 'DEPTH', { value: depth })} />
        <Slider id="breath-min" label="Min duty" value={minDuty} readout={minDuty} min={0} max={200} step={1}
          onChange={(v) => { touched.current.min = true; setMinDuty(v); }}
          onCommit={() => sendCommand(node.device_id, 'MIN', { value: minDuty })} />
        <p className="dim">
          Min duty: the lowest power the motors get whenever a curve is above zero. Raise
          it if they hum without turning at the quiet parts of the breath.
        </p>
      </section>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
