import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';
import ConfigSliders from '../../components/ConfigSliders';
import ConfigHeader from '../../components/ConfigHeader';

// Voice (esp32C3_organismo) device page: identity/telemetry, then every
// config value as a slider (see ConfigSliders — shared with VoiceCard, the
// compact grid version of this same device type), then the generic command
// panel for IDENTIFY/ALTER/UPDATE (SET is handled by the sliders instead).
export default function VoicePage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const config = node.config || {};
  const telemetryEntries = Object.entries(node.telemetry || {});
  const [hideUnset, setHideUnset] = useState(true);

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Voice <span className="device-id">{node.device_id}</span></h2>
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

      <ConfigHeader
        deviceId={node.device_id}
        name={config.name}
        onCommand={sendCommand}
        hideUnset={hideUnset}
        onHideUnsetChange={setHideUnset}
      />

      <ConfigSliders deviceId={node.device_id} config={node.config} onCommand={sendCommand} hideUnset={hideUnset} />

      <CommandPanel
        deviceId={node.device_id}
        capabilities={(caps.subscribes || []).filter((c) => c !== 'SET')}
        onCommand={sendCommand}
      />
    </div>
  );
}
