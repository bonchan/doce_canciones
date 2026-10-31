import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// time_interval — esp32C3_time_interval, three 7-segment digits each counting
// 0..9 on its own clock (leftmost fastest by default). This page sets how
// long each digit waits between numbers, plus a global speed that scales all
// three together. The device saves both in flash and publishes them
// (retained) on .../config, which shows up as node.config.
//
//   INTERVALS {ms: [left, middle, right]}  10..600000 ms per step
//   RATE      {value}  0.05..20, multiplies every digit's speed
//   PAUSE / RESUME / RESET (digits back to 0)
//
// See the command block in esp32C3_time_interval.ino.

const NAMES = ['Left', 'Middle', 'Right'];
const DEFAULT_MS = [100, 1000, 10000];
const MS_MIN = 10;
const MS_MAX = 600000;
const RATE_MIN = 0.05;
const RATE_MAX = 20;
const LIT = '#ef4444';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0', alignItems: 'center' };
const ON = { outline: '2px solid currentColor', opacity: 1 };
const HANDLED = ['INTERVALS', 'RATE', 'PAUSE', 'RESUME', 'RESET'];

// ── log sliders (positions 0..1000) ─────────────────────────────────────
// Intervals go from 10 ms to 10 min, so the slider is logarithmic and the
// value is rounded to 2 significant digits (100, 110, ..., 1000, 1100...).
const nice = (x) => Number(x.toPrecision(2));
const toPos = (v, lo, hi) => Math.round((Math.log(v / lo) / Math.log(hi / lo)) * 1000);
const fromPos = (p, lo, hi) => nice(lo * Math.pow(hi / lo, p / 1000));

function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

// ── 7-segment digit ─────────────────────────────────────────────────────
// Same bit order as the firmware: bit 0 = a ... bit 6 = g.
const SEGMENTS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const SEG_RECTS = [
  [12, 4, 36, 8],   // a
  [50, 12, 8, 34],  // b
  [50, 54, 8, 34],  // c
  [12, 88, 36, 8],  // d
  [2, 54, 8, 34],   // e
  [2, 12, 8, 34],   // f
  [12, 46, 36, 8],  // g
];

function Digit({ value, progress }) {
  const bits = SEGMENTS[value] || 0;
  return (
    <div style={{ width: 72 }}>
      <svg viewBox="0 0 60 100" style={{ width: '100%', display: 'block' }}>
        {SEG_RECTS.map(([x, y, w, h], s) => (
          <rect key={s} x={x} y={y} width={w} height={h} rx={4}
            fill={(bits >> s) & 1 ? LIT : 'var(--border)'} fillOpacity={(bits >> s) & 1 ? 1 : 0.35} />
        ))}
      </svg>
      {/* how far this digit is towards its next number — shows slow digits are alive */}
      <div style={{ height: 4, marginTop: 6, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ width: `${progress * 100}%`, height: '100%', background: LIT, borderRadius: 2 }} />
      </div>
    </div>
  );
}

// Runs the count in the browser at the given speeds, so you see what the
// sliders do while you drag them. Not synced to the device.
function usePreview(ms, rate, running) {
  const state = useRef({ digits: [0, 0, 0], phase: [0, 0, 0], at: null });
  const params = useRef({ ms, rate, running });
  useEffect(() => {
    params.current = { ms, rate, running };
  }, [ms, rate, running]);
  const [view, setView] = useState({ digits: [0, 0, 0], progress: [0, 0, 0] });

  useEffect(() => {
    let raf;
    const loop = (now) => {
      const s = state.current;
      const { ms: iv, rate: r, running: on } = params.current;
      const dt = s.at === null ? 0 : Math.min(now - s.at, 1000);
      s.at = now;
      if (on) {
        for (let i = 0; i < 3; i++) {
          s.phase[i] += dt * r;
          const steps = Math.floor(s.phase[i] / iv[i]);
          if (steps > 0) {
            s.phase[i] -= steps * iv[i];
            s.digits[i] = (s.digits[i] + steps) % 10;
          }
        }
      }
      setView({ digits: [...s.digits], progress: s.phase.map((p, i) => Math.min(1, p / iv[i])) });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const reset = () => {
    state.current.digits = [0, 0, 0];
    state.current.phase = [0, 0, 0];
  };
  return { ...view, reset };
}

function LogSlider({ id, label, value, lo, hi, readout, detail, onChange, onCommit }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 84px minmax(0, 1fr)', alignItems: 'center', gap: 12, margin: '10px 0' }}>
      <label htmlFor={id}>{label}</label>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{readout}</span>
      <div>
        <input id={id} type="range" style={{ width: '100%', minWidth: 0 }} min={0} max={1000} step={1}
          value={toPos(value, lo, hi)}
          onChange={(e) => onChange(fromPos(Number(e.target.value), lo, hi))}
          onMouseUp={onCommit} onTouchEnd={onCommit} onKeyUp={onCommit} />
        {detail && <div className="dim" style={{ fontSize: '0.85em' }}>{detail}</div>}
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────
export default function TimeIntervalPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetry = node.telemetry || {};
  const config = node.config || {};
  const hasConfig = Array.isArray(config.ms) && config.ms.length === 3;
  const id = node.device_id;

  // Sliders follow the device, except while one is being dragged.
  const [ms, setMs] = useState(hasConfig ? config.ms : DEFAULT_MS);
  const [rate, setRate] = useState(typeof config.rate === 'number' ? config.rate : 1);
  const dragging = useRef(false);
  const msKey = JSON.stringify(config.ms);
  useEffect(() => {
    if (!dragging.current && hasConfig) setMs(config.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msKey]);
  useEffect(() => {
    if (!dragging.current && typeof config.rate === 'number') setRate(config.rate);
  }, [config.rate]);

  const running = typeof config.running === 'boolean' ? config.running : telemetry.running !== 0;
  const preview = usePreview(ms, rate, running);

  const sendIntervals = (next) => {
    dragging.current = false;
    sendCommand(id, 'INTERVALS', { ms: next });
  };
  const changeDigit = (i, v) => {
    dragging.current = true;
    setMs((cur) => cur.map((x, j) => (j === i ? v : x)));
  };

  // Middle and right become 10× and 100× the left one: reads like a
  // (mirrored) odometer, with every digit stepping when the faster one wraps.
  const chainTen = () => {
    const left = ms[0];
    const next = [left, Math.min(MS_MAX, left * 10), Math.min(MS_MAX, left * 100)];
    setMs(next);
    sendIntervals(next);
  };

  const reset = () => {
    sendCommand(id, 'RESET', {});
    preview.reset();
  };

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Time interval <span className="device-id">{id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>State: <b>{hasConfig ? (running ? 'counting' : 'paused') : '-'}</b></span>
        <span>Device shows: <b style={{ fontVariantNumeric: 'tabular-nums' }}>{telemetry.digits ?? '-'}</b></span>
      </div>

      <section className="card">
        <h3>Preview</h3>
        <p className="dim">
          The count at these speeds, running here in the browser (it isn't synced to the
          device's digits). The bar under each digit is how close it is to the next number.
        </p>
        <div style={{ display: 'flex', gap: 14, margin: '12px 0' }}>
          {preview.digits.map((d, i) => <Digit key={i} value={d} progress={preview.progress[i]} />)}
        </div>
      </section>

      <section className="card">
        <h3>Speed</h3>
        <p className="dim">
          How long each digit waits before moving to the next number. Saved on the device
          as soon as you let go of the slider.
        </p>

        {ms.map((v, i) => (
          <LogSlider key={i} id={`interval-${i}`} label={NAMES[i]} value={v} lo={MS_MIN} hi={MS_MAX}
            readout={fmtMs(v)}
            detail={`0 → 9 takes ${fmtMs((v * 10) / rate)}${rate !== 1 ? ` (${fmtMs(v / rate)} per number at ${rate}×)` : ''}`}
            onChange={(x) => changeDigit(i, x)}
            onCommit={() => sendIntervals(ms)} />
        ))}

        <LogSlider id="interval-rate" label="All ×" value={rate} lo={RATE_MIN} hi={RATE_MAX}
          readout={`${rate}×`}
          detail="Speeds up or slows down all three digits at once, keeping their ratios."
          onChange={(x) => { dragging.current = true; setRate(x); }}
          onCommit={() => { dragging.current = false; sendCommand(id, 'RATE', { value: rate }); }} />

        <div style={ROW}>
          <button className="jog-btn" onClick={chainTen}>Middle ×10, right ×100</button>
          <button className="jog-btn" onClick={() => { setMs(DEFAULT_MS); sendIntervals(DEFAULT_MS); }}>Defaults</button>
          <button className="jog-btn" disabled={rate === 1}
            onClick={() => { setRate(1); sendCommand(id, 'RATE', { value: 1 }); }}>
            All × back to 1
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Count</h3>
        <div style={ROW}>
          <button className="jog-btn" style={running ? ON : null} onClick={() => sendCommand(id, 'RESUME', {})}>
            Count
          </button>
          <button className="jog-btn halt-btn" style={!running ? ON : null} onClick={() => sendCommand(id, 'PAUSE', {})}>
            Pause
          </button>
          <button className="jog-btn" onClick={reset}>Reset to 000</button>
        </div>
      </section>

      <CommandPanel deviceId={id} capabilities={(caps.subscribes || []).filter((c) => !HANDLED.includes(c))}
        onCommand={sendCommand} />
    </div>
  );
}
