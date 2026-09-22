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

// auto and mqtt are the two that matter in the gallery; mouse is for working
// on it, and serial is the plank, which you would not switch to from here but
// is worth being able to see and select.
const SOURCES = [
  { id: 'mqtt', label: 'MQTT (wind)', hint: 'carried by the anemometer on the bus' },
  { id: 'auto', label: 'Auto', hint: 'simulated breeze, no input needed' },
  { id: 'mouse', label: 'Mouse', hint: 'drag to steer, wheel for speed' },
  { id: 'serial', label: 'Plank', hint: 'the MPU-6050 over USB' },
];

export default function WindWorldPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const telemetry = node.telemetry || {};
  const presets = meta.presets || [];
  const species = meta.species || [];

  const [speed, setSpeed] = useState(5);
  const [direction, setDirection] = useState(180);
  // Only adopt the reported wind until the user first touches a slider, or
  // an incoming telemetry tick would yank the thumb back mid-adjustment.
  const touched = useRef(false);

  useEffect(() => {
    if (touched.current) return;
    if (typeof telemetry.wind === 'number') setSpeed(Math.round(telemetry.wind));
    if (typeof telemetry.wind_dir === 'number') setDirection(Math.round(telemetry.wind_dir));
  }, [telemetry.wind, telemetry.wind_dir]);

  const sendWind = () => sendCommand(node.device_id, 'WIND', { speed, direction });

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

      <section className="panel">
        <h3>Wind</h3>
        <p className="dim">
          An override. An anemometer publishing on the bus will overwrite this on its
          next reading.
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

      <section className="panel">
        <h3>Steering</h3>
        <p className="dim">
          {telemetry.pilot_active && telemetry.pilot_active !== telemetry.pilot
            ? `Asked for ${telemetry.pilot}, but running on ${telemetry.pilot_active}.`
            : 'MQTT drops to Auto by itself while the broker is unreachable, and returns on its own.'}
        </p>
        <div className="button-row">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              title={s.hint}
              className={telemetry.pilot === s.id ? 'active' : ''}
              onClick={() => sendCommand(node.device_id, 'PILOT', { source: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Display</h3>
        <p className="dim">
          Both start from [display] in the machine config.cfg; these override until it
          restarts.
        </p>
        <div className="button-row">
          <button
            className={telemetry.hud ? 'active' : ''}
            onClick={() => sendCommand(node.device_id, 'DISPLAY', { hud: !telemetry.hud })}
          >
            Debug HUD {telemetry.hud ? 'on' : 'off'}
          </button>
          <button
            className={telemetry.primitives ? 'active' : ''}
            title="The placeholder boxes and spheres some presets still mix in with the plants"
            onClick={() => sendCommand(node.device_id, 'DISPLAY', { primitives: !telemetry.primitives })}
          >
            Primitives {telemetry.primitives ? 'on' : 'off'}
          </button>
        </div>
      </section>

      <section className="panel">
        <h3>Preset</h3>
        {presets.length === 0 && (
          <p className="dim">
            The device has not advertised any presets. It sends them in its announce,
            so this fills in once it reconnects.
          </p>
        )}
        <div className="button-row">
          {presets.map((name) => (
            <button
              key={name}
              className={telemetry.preset === name ? 'active' : ''}
              onClick={() => sendCommand(node.device_id, 'PRESET', { name })}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Animals</h3>
        <p className="dim">
          Puts one in front of the camera, the same as pressing space on the machine
          itself. {typeof telemetry.animals === 'number' ? `${telemetry.animals} out there now.` : ''}
        </p>
        <div className="button-row">
          <button onClick={() => sendCommand(node.device_id, 'SPAWN', {})}>Any</button>
          {species.map((name) => (
            <button key={name} onClick={() => sendCommand(node.device_id, 'SPAWN', { species: name })}>
              {name}
            </button>
          ))}
        </div>
      </section>

      <CommandPanel
        deviceId={node.device_id}
        capabilities={(caps.subscribes || []).filter((c) => !['WIND', 'PRESET', 'SPAWN', 'PILOT', 'DISPLAY'].includes(c))}
        onCommand={sendCommand}
      />
    </div>
  );
}
