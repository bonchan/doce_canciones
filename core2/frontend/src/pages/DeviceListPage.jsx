import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DeviceCard from '../components/DeviceIndicator';
import VoiceCard from '../components/devices/VoiceCard';

// Per-type "particular" card registry — only used once the grid is
// filtered down to one type (see CardComponent below). Mixed/"all types"
// view always uses the plain DeviceCard, since a specialized card (e.g.
// full config sliders) only makes sense once every card in the grid is the
// same type. Anything not listed here still falls back to DeviceCard.
const TYPE_CARDS = {
  voice: VoiceCard,
};

// The original App.jsx grid, mounted (via DevicesPage) at /devices and
// /devices?type=<type>. typeFilter comes from the URL — when set, this is
// "every device of that type", zone-filterable on top via the chips below.
export default function DeviceListPage({ devices, wsStatus, apiKey, setApiKey, error, sendCommand, uploadAudio, typeFilter }) {
  const [zoneFilter, setZoneFilter] = useState('all');
  const CardComponent = (typeFilter && TYPE_CARDS[typeFilter]) || DeviceCard;

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

      <div className="grid">
        {sortedDevices.map((node) => (
          <CardComponent key={node.device_id} node={node} onCommand={sendCommand} uploadAudio={uploadAudio} />
        ))}
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
