import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../CommandPanel';
import ConfigSliders from '../ConfigSliders';
import ConfigHeader from '../ConfigHeader';

// The "particular" card for voice (esp32C3_organismo) devices — shown
// instead of the generic DeviceCard once the grid is filtered down to a
// single type (/devices?type=voice, see DeviceListPage's TYPE_CARDS). Same
// identity header as the generic card, but the body is the actual config
// sliders (shared with VoicePage via ConfigSliders) instead of a raw
// telemetry/capability dump, plus the audio upload button.
export default function VoiceCard({ node, onCommand, uploadAudio }) {
  const isOnline = node.online === true;
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const config = node.config || {};
  const telemetryEntries = Object.entries(node.telemetry || {});

  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [hideUnset, setHideUnset] = useState(true);

  // The <input> keeps whatever file was last picked, so re-selecting the
  // *same* file wouldn't otherwise fire a change event at all — clearing
  // its value here (before the async upload even starts) is what makes
  // clicking the button always re-prompt, every time.
  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    uploadAudio(node.device_id, file).finally(() => setUploading(false));
  };

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

      <div className="audio-upload">
        <button
          className="jog-btn"
          disabled={uploading}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          {uploading ? 'Uploading…' : 'Upload audio'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <span className="audio-filename dim">
          {config.audioFile ? `current: ${config.audioFile}` : 'no audio set'}
        </span>
      </div>

      <ConfigHeader
        deviceId={node.device_id}
        name={config.name}
        onCommand={onCommand}
        hideUnset={hideUnset}
        onHideUnsetChange={setHideUnset}
      />

      <ConfigSliders deviceId={node.device_id} config={node.config} onCommand={onCommand} hideUnset={hideUnset} />

      <Link className="open-link" to={`/devices?id=${node.device_id}`}>Open device page &rarr;</Link>

      <CommandPanel
        deviceId={node.device_id}
        capabilities={(caps.subscribes || []).filter((c) => c !== 'SET')}
        onCommand={onCommand}
      />
    </div>
  );
}
