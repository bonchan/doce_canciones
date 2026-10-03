import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// servos — esp32_servos, eight hobby servos on one ESP32. The firmware ramps
// every move at `spd` deg/s itself, so the page only ever says where to go:
//
//   SERVO   {i, pos} / {pos} / {pos: [..8]}, plus {speed}; i is 0-based
//           (i=0 is servo1 in telemetry)
//   CENTER  all to 90
//   SWEEP   ping-pong between min and max; {on: false} stops it
//   HALT    stop wherever they are
//   ALTER   the diagnostic 0-180 sweep for `duration` ms, then back
//
// See the command block at the top of esp32_servos.ino.

// Same fixed-width label/readout grid as WindWorldPage's Slider, so the track
// doesn't shift under the cursor when the number grows a digit.
const LABEL_COL = 84;
const VALUE_COL = 96;  // wide enough for "180° / 180°"
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 2px' };
const ON = { outline: '2px solid currentColor', opacity: 1 };

// Servo sliders send while dragging (a servo you can only aim on release is
// hard to use), but at most one message per this many ms.
const SEND_EVERY_MS = 80;

// Per-servo "reverse" flags live only in this browser (for now), keyed by
// device id. A reversed servo's slider means 180 - angle on the wire, both
// ways: what we send and how we read its telemetry back.
const reverseKey = (deviceId) => `servos.reverse.${deviceId}`;

function loadReverse(deviceId, n) {
  try {
    const saved = JSON.parse(localStorage.getItem(reverseKey(deviceId)) || '[]');
    return Array.from({ length: n }, (_, i) => saved[i] === true);
  } catch {
    return Array(n).fill(false);
  }
}

function saveReverse(deviceId, reverse) {
  try {
    localStorage.setItem(reverseKey(deviceId), JSON.stringify(reverse));
  } catch {
    // private window / blocked storage — the flags just won't survive a reload
  }
}

function Slider({ id, label, value, readout, min, max, step, onChange, onCommit, extra }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_COL}px ${VALUE_COL}px minmax(0, 1fr)${extra ? ' auto' : ''}`,
        alignItems: 'center',
        gap: 12,
        margin: '8px 0',
      }}
    >
      <label htmlFor={id} style={{ whiteSpace: 'nowrap' }}>{label}</label>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap', opacity: 0.75 }}>
        {readout}
      </span>
      <input
        id={id}
        type="range"
        style={{ width: '100%', minWidth: 0 }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
      />
      {extra}
    </div>
  );
}

export default function ServosPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const telemetry = node.telemetry || {};
  const n = typeof meta.n === 'number' ? meta.n : 8;
  const [reverse, setReverse] = useState(() => loadReverse(node.device_id, n));
  // Logical <-> physical angle. Its own inverse, so it's used both ways.
  const flip = (i, p) => (reverse[i] ? 180 - p : p);

  // servo1..servo8 in telemetry -> 0-based array, the same indexing SERVO's i
  // uses, already flipped into slider terms for reversed servos.
  const reported = Array.from({ length: n }, (_, i) => {
    const r = telemetry[`servo${i + 1}`];
    return typeof r === 'number' ? flip(i, r) : undefined;
  });
  const mode = telemetry.mode;

  const [pos, setPos] = useState(() => Array(n).fill(90));

  // Flipping a servo leaves it physically where it is — only the slider
  // mirrors — so nothing is sent.
  const toggleReverse = (i) => {
    const next = reverse.map((r, j) => (j === i ? !r : r));
    setReverse(next);
    saveReverse(node.device_id, next);
    setPos((prev) => prev.map((p, j) => (j === i ? 180 - p : p)));
  };
  const [all, setAll] = useState(90);
  const [speed, setSpeed] = useState(90);
  const [sweepMin, setSweepMin] = useState(0);
  const [sweepMax, setSweepMax] = useState(180);

  // Each slider follows the reported angle until it is first touched, so the
  // page opens showing where things actually are without a telemetry tick
  // later yanking a thumb out from under the user.
  const touched = useRef([]);
  const speedTouched = useRef(false);
  const reportedKey = reported.join(',');
  useEffect(() => {
    setPos((prev) => prev.map((p, i) => (touched.current[i] || typeof reported[i] !== 'number' ? p : reported[i])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedKey]);
  useEffect(() => {
    if (!speedTouched.current && typeof telemetry.spd === 'number') setSpeed(telemetry.spd);
  }, [telemetry.spd]);

  // Throttled per-servo sends, coalesced into one SERVO {pos: [...]} with
  // null for every servo that didn't change (the firmware skips nulls).
  const pending = useRef({});
  const timer = useRef(null);
  const flush = () => {
    timer.current = null;
    const changes = pending.current;
    pending.current = {};
    if (Object.keys(changes).length === 0) return;
    const arr = Array.from({ length: n }, (_, i) => (i in changes ? changes[i] : null));
    sendCommand(node.device_id, 'SERVO', { pos: arr });
  };
  const queue = (i, p) => {
    pending.current[i] = flip(i, p);
    if (!timer.current) timer.current = setTimeout(flush, SEND_EVERY_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const setOne = (i, p) => {
    touched.current[i] = true;
    setPos((prev) => prev.map((v, j) => (j === i ? p : v)));
    queue(i, p);
  };

  // Buttons that move everything also claim every slider, since the page now
  // knows where they're headed better than the last telemetry tick does.
  const moveAll = (p, cmd = 'SERVO') => {
    touched.current = Array(n).fill(true);
    setPos(Array(n).fill(p));
    setAll(p);
    if (cmd === 'CENTER') sendCommand(node.device_id, 'CENTER', {});
    // Per-servo array rather than one number, so reversed servos get 180 - p.
    else sendCommand(node.device_id, 'SERVO', { pos: Array.from({ length: n }, (_, i) => flip(i, p)) });
  };

  // After SWEEP / HALT / ALTER the sliders' values no longer mean anything,
  // so hand them back to telemetry.
  const release = () => {
    touched.current = [];
  };

  const sweeping = mode === 'sweep';

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Servos <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>Mode: <b>{mode || '-'}</b></span>
      </div>

      <section className="card">
        <h3>Servos</h3>
        <p className="dim">
          Sent while you drag. The number on the right is where the device last said
          that servo was (telemetry is once a second).
        </p>
        {pos.map((p, i) => (
          <Slider
            key={i}
            id={`servo-${i}`}
            label={`Servo ${i + 1}`}
            value={p}
            readout={`${p}° / ${typeof reported[i] === 'number' ? reported[i] : '–'}°`}
            min={0}
            max={180}
            step={1}
            onChange={(v) => setOne(i, v)}
            onCommit={flush}
            extra={
              <label style={{ whiteSpace: 'nowrap' }} title="Treat this servo as mounted backwards: slider angle is sent as 180 - angle">
                <input type="checkbox" checked={reverse[i]} onChange={() => toggleReverse(i)} /> reverse
              </label>
            }
          />
        ))}
      </section>

      <section className="card">
        <h3>All together</h3>
        <Slider
          id="servo-all"
          label="All"
          value={all}
          readout={`${all}°`}
          min={0}
          max={180}
          step={1}
          onChange={setAll}
          onCommit={() => moveAll(all)}
        />
        <div style={ROW}>
          <button className="jog-btn" onClick={() => moveAll(0)}>0°</button>
          <button className="jog-btn" onClick={() => moveAll(90, 'CENTER')}>Center</button>
          <button className="jog-btn" onClick={() => moveAll(180)}>180°</button>
          <button
            className="jog-btn halt-btn"
            onClick={() => {
              release();
              sendCommand(node.device_id, 'HALT', {});
            }}
          >
            HALT
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Speed</h3>
        <p className="dim">How fast the device ramps every move. 0 jumps straight there.</p>
        <Slider
          id="servo-speed"
          label="Speed"
          value={speed}
          readout={speed === 0 ? 'instant' : `${speed}°/s`}
          min={0}
          max={360}
          step={5}
          onChange={(v) => {
            speedTouched.current = true;
            setSpeed(v);
          }}
          onCommit={() => sendCommand(node.device_id, 'SERVO', { speed })}
        />
      </section>

      <section className="card">
        <h3>Sweep</h3>
        <p className="dim">
          Every servo back and forth between min and max at the speed above. The
          device runs the sweep itself and doesn't know about reverse yet, so
          reversed servos swing the mirrored way (and over 180 − max … 180 − min).
        </p>
        <Slider id="sweep-min" label="Min" value={sweepMin} readout={`${sweepMin}°`} min={0} max={180} step={1}
          onChange={setSweepMin} onCommit={() => {}} />
        <Slider id="sweep-max" label="Max" value={sweepMax} readout={`${sweepMax}°`} min={0} max={180} step={1}
          onChange={setSweepMax} onCommit={() => {}} />
        <div style={ROW}>
          <button
            className="jog-btn"
            style={sweeping ? ON : null}
            onClick={() => {
              release();
              sendCommand(node.device_id, 'SWEEP', { speed, min: sweepMin, max: sweepMax });
            }}
          >
            {sweeping ? 'Restart sweep' : 'Start sweep'}
          </button>
          <button
            className="jog-btn"
            disabled={!sweeping}
            onClick={() => sendCommand(node.device_id, 'SWEEP', { on: false })}
          >
            Stop sweep
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Alter</h3>
        <p className="dim">
          The diagnostic sweep — all servos 0 → 180 → 0 in 15° jumps — for the whole
          duration, then they ease back to what they were doing.
        </p>
        <div style={ROW}>
          {[3, 5, 10, 30].map((secs) => (
            <button
              key={secs}
              className="jog-btn"
              style={mode === 'alter' ? ON : null}
              onClick={() => sendCommand(node.device_id, 'ALTER', { duration: secs * 1000 })}
            >
              {secs}s
            </button>
          ))}
        </div>
      </section>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
