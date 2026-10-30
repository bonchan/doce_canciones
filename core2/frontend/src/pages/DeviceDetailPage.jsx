import React from 'react';
import { Link } from 'react-router-dom';
import DevicePage from './devices/devicePages';

// deviceId comes from DevicesPage (reading ?id=... off the URL).
export default function DeviceDetailPage({ devices, sendCommand, drawSolarPath, drawText, cancelDrawing, uploadAudio, error, deviceId }) {
  const node = devices[deviceId];

  if (!node) {
    return (
      <div className="app device-page">
        <Link className="back-link" to="/devices">&larr; Back to devices</Link>
        <p className="dim">No device with id "{deviceId}" in the registry.</p>
      </div>
    );
  }

  return (
    <DevicePage
      node={node}
      sendCommand={sendCommand}
      drawSolarPath={drawSolarPath}
      drawText={drawText}
      cancelDrawing={cancelDrawing}
      uploadAudio={uploadAudio}
      error={error}
    />
  );
}
