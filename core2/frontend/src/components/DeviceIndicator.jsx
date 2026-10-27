import React from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from './CommandPanel';

// Renders one registry entry as a card: identity, live telemetry, a link to
// the device's own page (per-type page if one exists, generic fallback
// otherwise), and every capability it declared in `subscribes` as a
// clickable button via CommandPanel. Kept the filename to avoid renaming a
// file the user already has open.
export default function DeviceCard({ node, onCommand, onDelete }) {
  const isOnline = node.online === true;
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetryEntries = Object.entries(node.telemetry || {});

  return (
    <div className={`card ${isOnline ? '' : 'offline'}`}>
      <div className="card-header">
        <span className="dot" style={{ background: isOnline ? '#10b981' : '#ef4444' }} />
        {node.type ? (
          <Link className="type-link" to={`/devices?type=${node.type}`} title={`Show all ${node.type} devices`}>
            <strong>{node.type}</strong>
          </Link>
        ) : (
          <strong>unknown</strong>
        )}
        <span className="device-id">{node.device_id}</span>
      </div>

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

      <Link className="open-link" to={`/devices?id=${node.device_id}`}>Open device page &rarr;</Link>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes} onCommand={onCommand} />

      {/* only offline ones: an online device keeps publishing and would come straight back */}
      {!isOnline && onDelete && (
        <button
          className="delete-device"
          title="Remove it from the list and from Firebase. If it is switched on again it shows up as new."
          onClick={() => {
            if (window.confirm(`Delete ${node.type || 'device'} ${node.device_id}?`)) onDelete(node.device_id).catch(() => {});
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
