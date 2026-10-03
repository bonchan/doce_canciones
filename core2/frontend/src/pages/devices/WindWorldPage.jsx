import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// display.wind_world — the Godot piece (C02/wind_world) joined to the bus as
// an ordinary device. Three things worth controlling from here:
//
//   WIND    speed + direction, for when there is no anemometer on the bus (or
//           you want to force weather for a photo). A real anemometer reading
//           simply overwrites whatever you set here on its next telemetry, so
//           these sliders are an override, not a mode.
//   PRESET  which world it is looking at.
//   SPAWN   drop an animal in front of the camera.
//   DISPLAY the debug HUD, and whether the placeholder primitives are drawn.
//   ALTER   the disaster. Duration in ms, as the ESP32 firmware uses.
//
// The preset and species lists are NOT hardcoded here — the piece advertises
// both in its announce, and the backend passes unknown announce fields
// through into node.meta untouched (same as the polargraph's geometry). So
// adding a preset in Godot makes a button appear here with no frontend
// change at all.

// Only fires the command when the drag ends, so one slow drag is one message
// on the broker rather than sixty.
//
// The label and the readout are fixed-width and the readout uses tabular
// figures, so going 9 -> 10 m/s cannot change their width. Otherwise the text
// grows, the grid column grows with it, and the track shifts under the cursor
// mid-drag.
const LABEL_COL = 84;
const VALUE_COL = 66;

function Slider({ label, value, min, max, step, unit, onChange, onCommit }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_COL}px ${VALUE_COL}px minmax(0, 1fr)`,
        alignItems: 'center',
        gap: 12,
        margin: '8px 0',
      }}
    >
      <label htmlFor={`wind-${label}`} style={{ whiteSpace: 'nowrap' }}>
        {label}
      </label>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          opacity: 0.75,
        }}
      >
        {value}
        {unit}
      </span>
      <input
        id={`wind-${label}`}
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
    </div>
  );
}

// mqtt is what the gallery runs on; auto is the fallback it uses by itself
// when the broker is unreachable; mouse is for working on it.
// App.css has .card and .jog-btn; it has no .panel, no .button-row and no
// .active, so those are done here rather than invented in the stylesheet.
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 2px' };
const ON = { outline: '2px solid currentColor', opacity: 1 };

const SOURCES = [
  { id: 'mqtt', label: 'MQTT (wind)', hint: 'carried by the anemometer on the bus' },
  { id: 'auto', label: 'Auto', hint: 'simulated breeze, no input needed' },
  { id: 'mouse', label: 'Mouse', hint: 'drag to steer, wheel for speed' },
];

export default function WindWorldPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const telemetry = node.telemetry || {};
  const presets = meta.presets || [];
  const species = meta.species || [];

  const [speed, setSpeed] = useState(5);
  const [direction, setDirection] = useState(180);
  const [gain, setGain] = useState(3);
  const gainTouched = useRef(false);
  // Only adopt the reported wind until the user first touches a slider, or
  // an incoming telemetry tick would yank the thumb back mid-adjustment.
  const touched = useRef(false);

  useEffect(() => {
    if (touched.current) return;
    if (typeof telemetry.wind === 'number') setSpeed(Math.round(telemetry.wind));
    if (typeof telemetry.wind_dir === 'number') setDirection(Math.round(telemetry.wind_dir));
  }, [telemetry.wind, telemetry.wind_dir]);

  useEffect(() => {
    if (gainTouched.current) return;
    if (typeof telemetry.wind_gain === 'number') setGain(telemetry.wind_gain);
  }, [telemetry.wind_gain]);

  const sendWind = () => sendCommand(node.device_id, 'WIND', { speed, direction });
  const sendGain = () => sendCommand(node.device_id, 'WIND', { gain });

  const telemetryEntries = Object.entries(telemetry);

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Wind world <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>Preset: <b>{telemetry.preset || '-'}</b></span>
      </div>

      <div className="telemetry">
        {telemetryEntries.length === 0 && <span className="dim">no telemetry yet</span>}
        {telemetryEntries.map(([k, v]) => (
          <div key={k} className="telemetry-row">
            <span>{k}</span>
            <span>{typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}</span>
          </div>
        ))}
      </div>

      <section className="card">
        <h3>Wind</h3>
        <p className="dim">
          The multiplier scales every anemometer reading before it drives anything, so
          real wind can be made worth watching. 1 would travel at exactly the reported
          speed; it starts at 3.
          {typeof telemetry.wind_steady === 'number'
            ? ` Direction is ${Math.round(telemetry.wind_steady * 100)}% settled — below
               about 12% the heading is held rather than chased.`
            : ''}
        </p>
        <Slider
          label="Multiplier"
          value={gain}
          min={0.5}
          max={12}
          step={0.5}
          unit="&times;"
          onChange={(v) => {
            gainTouched.current = true;
            setGain(v);
          }}
          onCommit={sendGain}
        />
        <p className="dim">
          Below is an override for when there is no anemometer on the bus — a real
          reading overwrites it on the next tick.
        </p>
        <Slider
          label="Speed"
          value={speed}
          min={0}
          max={18}
          step={0.5}
          unit=" m/s"
          onChange={(v) => {
            touched.current = true;
            setSpeed(v);
          }}
          onCommit={sendWind}
        />
        <Slider
          label="Direction"
          value={direction}
          min={0}
          max={359}
          step={1}
          unit="&deg;"
          onChange={(v) => {
            touched.current = true;
            setDirection(v);
          }}
          onCommit={sendWind}
        />
      </section>

      <section className="card">
        <h3>Steering</h3>
        <p className="dim">
          {telemetry.pilot_active && telemetry.pilot_active !== telemetry.pilot
            ? `Set to ${telemetry.pilot}, but the broker is unreachable, so it is running on ${telemetry.pilot_active}.`
            : 'MQTT drops to Auto by itself while the broker is unreachable, and returns on its own.'}
        </p>
        <div style={ROW}>
          {SOURCES.map((s) => (
            <button
              key={s.id}
              title={s.hint}
              className="jog-btn" style={telemetry.pilot === s.id ? ON : null}
              onClick={() => sendCommand(node.device_id, 'PILOT', { source: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Alter</h3>
        <p className="dim">
          Cracks the ground open, shows the void through it and floods petrol out over
          everything, then lets it close. Takes about 2s to tear and 5s to heal either
          side of the duration.
          {typeof telemetry.alter === 'number' && telemetry.alter > 0
            ? ` Currently ${Math.round(telemetry.alter * 100)}% open.`
            : ''}
        </p>
        <div style={ROW}>
          {[5, 10, 30].map((secs) => (
            <button
              key={secs}
              className="jog-btn"
              onClick={() => sendCommand(node.device_id, 'ALTER', { duration: secs * 1000 })}
            >
              {secs}s
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Display</h3>
        <p className="dim">
          All of these start from [display] in the machine config.cfg; changing them
          here overrides that until it restarts.
          {telemetry.grass === false ? ' Grass is off on this machine (startup only).' : ''}
        </p>
        <div style={ROW}>
          <button
            className="jog-btn" style={telemetry.fullscreen ? ON : null}
            title="Borderless fullscreen. F does the same on the machine itself."
            onClick={() => sendCommand(node.device_id, 'DISPLAY', { fullscreen: !telemetry.fullscreen })}
          >
            Fullscreen {telemetry.fullscreen ? 'on' : 'off'}
          </button>
          <button
            className="jog-btn" style={telemetry.hud ? ON : null}
            onClick={() => sendCommand(node.device_id, 'DISPLAY', { hud: !telemetry.hud })}
          >
            Debug HUD {telemetry.hud ? 'on' : 'off'}
          </button>
          <button
            className="jog-btn" style={telemetry.primitives ? ON : null}
            title="The placeholder boxes and spheres some presets still mix in with the plants"
            onClick={() => sendCommand(node.device_id, 'DISPLAY', { primitives: !telemetry.primitives })}
          >
            Primitives {telemetry.primitives ? 'on' : 'off'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Preset</h3>
        {presets.length === 0 && (
          <p className="dim">
            The device has not advertised any presets. It sends them in its announce,
            so this fills in once it reconnects.
          </p>
        )}
        <div style={ROW}>
          {presets.map((name) => (
            <button
              key={name}
              className="jog-btn" style={telemetry.preset === name ? ON : null}
              onClick={() => sendCommand(node.device_id, 'PRESET', { name })}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Animals</h3>
        <p className="dim">
          Puts one in front of the camera, the same as pressing space on the machine
          itself. {typeof telemetry.animals === 'number' ? `${telemetry.animals} out there now.` : ''}
        </p>
        <div style={ROW}>
          <button className="jog-btn" onClick={() => sendCommand(node.device_id, 'SPAWN', {})}>Any</button>
          {species.map((name) => (
            <button key={name} className="jog-btn" onClick={() => sendCommand(node.device_id, 'SPAWN', { species: name })}>
              {name}
            </button>
          ))}
        </div>
      </section>

      <CommandPanel
        deviceId={node.device_id}
        capabilities={caps.subscribes || []}
        onCommand={sendCommand}
      />
    </div>
  );
}
