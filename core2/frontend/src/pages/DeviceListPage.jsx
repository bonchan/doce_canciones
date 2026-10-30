import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DeviceCard from '../components/DeviceIndicator';
import DevicePage from './devices/devicePages';

// The original App.jsx grid, mounted (via DevicesPage) at /devices and
// /devices?type=<type>. typeFilter comes from the URL — when set, this is
// "every device of that type", zone-filterable on top via the chips below,
// and each device is shown as its full particular page (the same one
// /devices?id=... shows) instead of a compact card.
export default function DeviceListPage({ devices, wsStatus, apiKey, setApiKey, error, sendCommand, drawSolarPath, drawText, cancelDrawing, uploadAudio, deleteDevice, typeFilter }) {
  const [zoneFilter, setZoneFilter] = useState('all');

  const typeFilteredDevices = useMemo(
    () => Object.values(devices).filter((d) => !typeFilter || d.type === typeFilter),
    [devices, typeFilter]
  );

  // Whatever zones show up among the (type-filtered) devices so far — no
  // hardcoded list, so a new zone just appears here the first time a
  // matching device announces.
  const zones = useMemo(() => {
    const set = new Set();
    typeFilteredDevices.forEach((d) => {
      if (d.zone) set.add(d.zone);
    });
    return Array.from(set).sort();
  }, [typeFilteredDevices]);

  // If the selected zone disappears (e.g. its only device hasn't announced
  // yet after a backend restart, or a type filter now excludes it), fall
  // back to "all" instead of silently showing an empty grid forever.
  useEffect(() => {
    if (zoneFilter !== 'all' && !zones.includes(zoneFilter)) {
      setZoneFilter('all');
    }
  }, [zones, zoneFilter]);

  const sortedDevices = typeFilteredDevices
    .filter((d) => zoneFilter === 'all' || d.zone === zoneFilter)
    .sort((a, b) => {
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

      {typeFilter && (
        <div className="type-filter-banner">
          Showing <b>{typeFilter}</b> devices — <Link to="/devices">clear filter</Link>
        </div>
      )}

      <div className="zone-filter">
        <button
          className={`tag tag-btn${zoneFilter === 'all' ? ' active' : ''}`}
          onClick={() => setZoneFilter('all')}
        >
          All zones
        </button>
        {zones.map((zone) => (
          <button
            key={zone}
            className={`tag tag-btn${zoneFilter === zone ? ' active' : ''}`}
            onClick={() => setZoneFilter(zone)}
          >
            {zone}
          </button>
        ))}
      </div>

      <div className={typeFilter ? 'device-page-grid' : 'grid'}>
        {sortedDevices.map((node) => {
          if (!typeFilter) {
            return (
              <DeviceCard key={node.device_id} node={node} onCommand={sendCommand}
                onDelete={apiKey ? deleteDevice : null} />
            );
          }
          return (
            <div key={node.device_id} className="embedded-device-page">
              <Link className="open-link" to={`/devices?id=${node.device_id}`}>Open on its own &rarr;</Link>
              {/* error is shown once above, not repeated inside every page */}
              <DevicePage node={node} sendCommand={sendCommand} drawSolarPath={drawSolarPath} drawText={drawText}
                cancelDrawing={cancelDrawing} uploadAudio={uploadAudio} error={null} />
            </div>
          );
        })}
        {sortedDevices.length === 0 && (
          <div className="empty">
            {typeFilter && zoneFilter !== 'all'
              ? `No "${typeFilter}" devices registered in "${zoneFilter}" yet.`
              : typeFilter
              ? `No "${typeFilter}" devices have announced themselves yet.`
              : zoneFilter !== 'all'
              ? `No devices registered in "${zoneFilter}" yet.`
              : 'No devices have announced themselves yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
