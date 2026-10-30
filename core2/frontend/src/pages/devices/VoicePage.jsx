import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';
import ConfigSliders from '../../components/ConfigSliders';
import ConfigHeader from '../../components/ConfigHeader';
import AudioUpload from '../../components/AudioUpload';

// Voice (esp32C3_organismo / esp32c3_voices) device page: identity/
// telemetry, audio upload, mute, every config value as a slider, then the
// generic command panel for the rest (SET and MUTE have their own controls).
export default function VoicePage({ node, sendCommand, uploadAudio, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const config = node.config || {};
  const telemetryEntries = Object.entries(node.telemetry || {});
  const [hideUnset, setHideUnset] = useState(true);
  // Reported by the device in telemetry. Devices always boot unmuted.
  const muted = node.telemetry?.muted === true;

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

      <AudioUpload deviceId={node.device_id} audioFile={config.audioFile} uploadAudio={uploadAudio} />

      {/* Mute silences the organism's behaviour (it keeps running underneath);
          AUDIO_PLAY in the command panel below still plays the raw file. */}
      <div className="jog-controls">
        <button
          className={`jog-btn${muted ? ' active' : ''}`}
          disabled={!node.online}
          onClick={() => sendCommand(node.device_id, 'MUTE', { muted: !muted })}
        >
          {muted ? 'Muted — click to unmute' : 'Mute'}
        </button>
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
        capabilities={(caps.subscribes || []).filter((c) => c !== 'SET' && c !== 'MUTE')}
        onCommand={sendCommand}
      />
    </div>
  );
}
