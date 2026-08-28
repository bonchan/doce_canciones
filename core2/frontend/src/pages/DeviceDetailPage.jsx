import React from 'react';
import { Link } from 'react-router-dom';
import PolargraphPage from './devices/PolargraphPage';
import VoicePage from './devices/VoicePage';
import NotImplementedPage from './NotImplementedPage';

// Per-type page registry — add an entry here when a device type gets its
// own page. Anything not listed falls back to NotImplementedPage.
const DEVICE_PAGES = {
  polargraph: PolargraphPage,
  voice: VoicePage,
};

// deviceId now comes from DevicesPage (reading ?id=... off the URL) rather
// than a :deviceId route param — this component itself doesn't care which,
// it just needs the id.
export default function DeviceDetailPage({ devices, sendCommand, drawSolarPath, drawText, cancelDrawing, error, deviceId }) {
  const node = devices[deviceId];

  if (!node) {
    return (
      <div className="app device-page">
        <Link className="back-link" to="/devices">&larr; Back to devices</Link>
        <p className="dim">No device with id "{deviceId}" in the registry.</p>
      </div>
    );
  }

  const Page = DEVICE_PAGES[node.type] || NotImplementedPage;
  return (
    <Page
      node={node}
      sendCommand={sendCommand}
      drawSolarPath={drawSolarPath}
      drawText={drawText}
      cancelDrawing={cancelDrawing}
      error={error}
    />
  );
}
