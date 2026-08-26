import React from 'react';
import { Link, useParams } from 'react-router-dom';
import PolargraphPage from './devices/PolargraphPage';
import NotImplementedPage from './NotImplementedPage';

// Per-type page registry — add an entry here when a device type gets its
// own page. Anything not listed falls back to NotImplementedPage.
const DEVICE_PAGES = {
  polargraph: PolargraphPage,
};

export default function DeviceDetailPage({ devices, sendCommand, drawSolarPath, cancelDrawing, error }) {
  const { deviceId } = useParams();
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
      cancelDrawing={cancelDrawing}
      error={error}
    />
  );
}
