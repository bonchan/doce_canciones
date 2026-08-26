import React from 'react';
import DeviceCard from '../components/DeviceIndicator';

// The original App.jsx grid, now just one route. Takes the shared
// useDevices() state as props so it stays in sync with the detail pages.
export default function DeviceListPage({ devices, wsStatus, apiKey, setApiKey, error, sendCommand }) {
  const sortedDevices = Object.values(devices).sort((a, b) => {
    const typeA = (a.type || '').toLowerCase();
    const typeB = (b.type || '').toLowerCase();
    if (typeA !== typeB) return typeA < typeB ? -1 : 1;
    return (b.online ? 1 : 0) - (a.online ? 1 : 0);
  });

  return (
    <div className="app">
      <header className="header">
        <div>
          <h2>Brain Core</h2>
          <div className={`status-badge ${wsStatus === 'Connected' ? 'connected' : 'disconnected'}`}>
            {wsStatus}
          </div>
        </div>
        <div className="api-key">
          <label htmlFor="api-key-input">X-API-Key</label>
          <input
            id="api-key-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="only needed to send commands"
          />
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid">
        {sortedDevices.map((node) => (
          <DeviceCard key={node.device_id} node={node} onCommand={sendCommand} />
        ))}
        {sortedDevices.length === 0 && (
          <div className="empty">No devices have announced themselves yet.</div>
        )}
      </div>
    </div>
  );
}
