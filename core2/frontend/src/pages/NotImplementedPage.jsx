import React from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../components/CommandPanel';

// Fallback for any device type without a dedicated page — still shows
// identity/telemetry/commands so the device is usable, just not pretty.
export default function NotImplementedPage({ node, sendCommand }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetryEntries = Object.entries(node.telemetry || {});

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>{node.type || 'unknown'} <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      <p className="dim">No dedicated page for device type "{node.type}" yet — showing generic controls.</p>

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

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes} onCommand={sendCommand} />
    </div>
  );
}
