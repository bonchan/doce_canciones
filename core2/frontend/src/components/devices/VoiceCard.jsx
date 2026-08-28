import React from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../CommandPanel';
import ConfigSliders from '../ConfigSliders';

// The "particular" card for voice (esp32C3_organismo) devices — shown
// instead of the generic DeviceCard once the grid is filtered down to a
// single type (/devices?type=voice, see DeviceListPage's TYPE_CARDS). Same
// identity header as the generic card, but the body is the actual config
// sliders (shared with VoicePage via ConfigSliders) instead of a raw
// telemetry/capability dump.
export default function VoiceCard({ node, onCommand }) {
  const isOnline = node.online === true;
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const telemetryEntries = Object.entries(node.telemetry || {});

  return (
    <div className={`card ${isOnline ? '' : 'offline'}`}>
      <div className="card-header">
        <span className="dot" style={{ background: isOnline ? '#10b981' : '#ef4444' }} />
        <strong>{node.type || 'unknown'}</strong>
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

      <ConfigSliders deviceId={node.device_id} config={node.config} onCommand={onCommand} />

      <Link className="open-link" to={`/devices?id=${node.device_id}`}>Open device page &rarr;</Link>

      <CommandPanel
        deviceId={node.device_id}
        capabilities={(caps.subscribes || []).filter((c) => c !== 'SET')}
        onCommand={onCommand}
      />
    </div>
  );
}
