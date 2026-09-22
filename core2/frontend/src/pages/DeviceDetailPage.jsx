import React from 'react';
import { Link } from 'react-router-dom';
import PolargraphPage from './devices/PolargraphPage';
import VoicePage from './devices/VoicePage';
import WindWorldPage from './devices/WindWorldPage';
import NotImplementedPage from './NotImplementedPage';

// Per-type page registry — add an entry here when a device type gets its
// own page. Anything not listed falls back to NotImplementedPage.
const DEVICE_PAGES = {
  polargraph: PolargraphPage,
  voice: VoicePage,
  display: DisplayPage,
  // If the Godot piece is ever given a type of its own, this is the key it
  // would use, and DisplayPage below stops being needed.
  'display.wind_world': WindWorldPage,
};

// Two different devices announce type "display" on this bus: BichitoPantallas
// and the Godot wind world. The registry keys on type alone, so they cannot
// be told apart by it -- and the backend drops "sn" from the announce, so
// that is no help either. What IS distinctive is that the wind world
// advertises its preset list in the announce, which lands in node.meta.
//
// This is a workaround for two devices sharing one type, not a pattern to
// copy. Giving the piece its own type would delete this function.
function DisplayPage(props) {
  const meta = props.node.meta || {};
  return meta.presets ? <WindWorldPage {...props} /> : <NotImplementedPage {...props} />;
}

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
