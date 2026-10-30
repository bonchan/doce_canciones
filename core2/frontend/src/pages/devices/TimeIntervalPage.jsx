import React from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// time_interval — esp32C3_time_interval. For now the sketch is a shell (it
// only answers the default IDENTIFY / ALTER / UPDATE and publishes
// placeholder telemetry), and so is this page: identity, raw telemetry and
// the generic command panel. The "Interval" card is where the device's own
// controls go once the firmware defines its commands and config.
export default function TimeIntervalPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetryEntries = Object.entries(node.telemetry || {});

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Time interval <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
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
        <h3>Interval</h3>
        <p className="dim">Nothing here yet — the device doesn't have its own commands.</p>
      </section>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
