import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// breathe — esp32C3_breathe, two one-way DC motors on an L298N blowing into
// the same funnel: one inhales, the other exhales. A breath is two curves
// (one per motor) of speed samples 0..255 spread over `period` ms, looped
// forever. You draw them here; the device stores them in flash and
// publishes what it has (retained) on .../config, which shows up as
// node.config.
//
//   CURVE   {period, in: [..], out: [..]}  any subset; 2..128 samples each
//   PAUSE / RESUME
//   RATE  {value}  0.1..10   time multiplier
//   DEPTH {value}  0..1      speed multiplier
//   MIN   {value}  0..254    duty below which the motors stall
//
// See the command block in esp32C3_breathe.ino.

const SAMPLES = 64;
const W = 1000;      // viewBox width
const H = 200;       // viewBox height per lane
const INHALE = '#3b82f6';
const EXHALE = '#f97316';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0', alignItems: 'center' };
const ON = { outline: '2px solid currentColor', opacity: 1 };

// ── curve helpers ─────────────────────────────────────────────────────────
// Same shape the firmware uses for its defaults: a half-sine from `from`
// to `to` (fractions of the breath), 0 elsewhere.
function bump(n, from, to, peak) {
  return Array.from({ length: n }, (_, i) => {
    const x = (i / n - from) / (to - from);
    return x > 0 && x < 1 ? Math.round(peak * Math.sin(Math.PI * x)) : 0;
  });
}

const addCurves = (a, b) => a.map((v, i) => Math.min(255, v + b[i]));

const PRESETS = {
  Calm: () => ({ period: 8000, in: bump(SAMPLES, 0, 0.4, 200), out: bump(SAMPLES, 0.5, 0.9, 180) }),
  Deep: () => ({ period: 12000, in: bump(SAMPLES, 0, 0.45, 255), out: bump(SAMPLES, 0.5, 0.95, 230) }),
  Panting: () => ({ period: 1500, in: bump(SAMPLES, 0, 0.45, 220), out: bump(SAMPLES, 0.5, 0.95, 220) }),
  Sigh: () => ({
    period: 10000,
    in: addCurves(bump(SAMPLES, 0, 0.25, 200), bump(SAMPLES, 0.25, 0.4, 150)),
    out: bump(SAMPLES, 0.45, 0.95, 160),
  }),
  Hold: () => ({ period: 10000, in: bump(SAMPLES, 0, 0.3, 200), out: bump(SAMPLES, 0.6, 0.9, 200) }),
};

// 3-tap moving average that wraps around, since the breath loops
function smooth(v) {
  const n = v.length;
  return v.map((x, i) => Math.round((v[(i - 1 + n) % n] + 2 * x + v[(i + 1) % n]) / 4));
}

const sameCurve = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function fromConfig(config) {
  if (!config || !Array.isArray(config.in) || !Array.isArray(config.out)) return null;
  return { period: config.period || 8000, in: config.in, out: config.out };
}

// Polygon points for a looping curve: one point per sample, plus a closing
// point at the right edge with sample 0's value (the device blends the last
// sample back into the first).
function curvePoints(v) {
  const n = v.length;
  const pts = v.map((x, i) => `${(i / n) * W},${H - (x / 255) * H}`);
  pts.push(`${W},${H - (v[0] / 255) * H}`);
  return pts;
}

// ── one motor's lane ──────────────────────────────────────────────────────
function Lane({ label, color, values, saved, onChange, phase, period, live }) {
  const svgRef = useRef(null);
  const last = useRef(null);  // last painted [index, value], to fill gaps on fast drags

  const paintAt = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const n = values.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
    const v = Math.max(0, Math.min(255, Math.round((1 - (e.clientY - r.top) / r.height) * 255)));
    const next = values.slice();
    const [pi, pv] = last.current || [i, v];
    const steps = Math.abs(i - pi);
    for (let s = 0; s <= steps; s++) {
      const k = steps === 0 ? 1 : s / steps;
      next[Math.round(pi + (i - pi) * k)] = Math.round(pv + (v - pv) * k);
    }
    last.current = [i, v];
    onChange(next);
  };

  const pts = curvePoints(values);
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  const seconds = period / 1000;
  const tickEvery = seconds > 20 ? 5 : seconds > 6 ? 1 : 0.5;
  const ticks = [];
  for (let s = tickEvery; s < seconds; s += tickEvery) ticks.push(s);

  return (
    <div style={{ margin: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style={{ color }}>{label}</b>
        <span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {typeof live === 'number' ? `duty now ${live}` : ''}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{
          width: '100%',
          height: 150,
          display: 'block',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--code-bg)',
          touchAction: 'none',
          cursor: 'crosshair',
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          last.current = null;
          paintAt(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) paintAt(e);
        }}
        onPointerUp={() => {
          last.current = null;
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
        ))}
        {ticks.map((s) => (
          <line key={s} x1={(s / seconds) * W} x2={(s / seconds) * W} y1={0} y2={H}
            stroke="var(--border)" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} fillOpacity={0.25} />
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {saved && !sameCurve(saved, values) && (
          <polyline points={curvePoints(saved).join(' ')} fill="none" stroke="var(--text)"
            strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        {typeof phase === 'number' && (
          <line x1={phase * W} x2={phase * W} y1={0} y2={H} stroke="var(--text-h)" strokeWidth={2}
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>
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

  const matchesDevice =
    saved && saved.period === draft.period && sameCurve(saved.in, draft.in) && sameCurve(saved.out, draft.out);

  const saveToDevice = () => {
    sendCommand(node.device_id, 'CURVE', { period: draft.period, in: draft.in, out: draft.out });
    // stays "dirty" until the device's retained config echoes it back
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
          Draw each motor's speed over one breath; it loops. Higher = faster. The
          dashed line is what's saved on the device, when it differs from your drawing.
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
        </div>

        <Lane label="Inhale" color={INHALE} values={draft.in} saved={saved && saved.in}
          onChange={(v) => edit({ in: v })} phase={phase} period={draft.period} live={telemetry.inhale} />
        <div style={ROW}>
          <button className="jog-btn" onClick={() => edit({ in: smooth(draft.in) })}>Smooth inhale</button>
          <button className="jog-btn" onClick={() => edit({ in: Array(draft.in.length).fill(0) })}>Clear inhale</button>
        </div>

        <Lane label="Exhale" color={EXHALE} values={draft.out} saved={saved && saved.out}
          onChange={(v) => edit({ out: v })} phase={phase} period={draft.period} live={telemetry.exhale} />
        <div style={ROW}>
          <button className="jog-btn" onClick={() => edit({ out: smooth(draft.out) })}>Smooth exhale</button>
          <button className="jog-btn" onClick={() => edit({ out: Array(draft.out.length).fill(0) })}>Clear exhale</button>
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
