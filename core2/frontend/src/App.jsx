import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import useDevices from './hooks/useDevices';
import DevicesPage from './pages/DevicesPage';

export default function App() {
  const {
    devices,
    wsStatus,
    apiKey,
    setApiKey,
    error,
    sendCommand,
    drawSolarPath,
    drawText,
    cancelDrawing,
    uploadAudio,
  } = useDevices();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/devices" replace />} />
        <Route
          path="/devices"
          element={
            <DevicesPage
              devices={devices}
              wsStatus={wsStatus}
              apiKey={apiKey}
              setApiKey={setApiKey}
              error={error}
              sendCommand={sendCommand}
              drawSolarPath={drawSolarPath}
              drawText={drawText}
              cancelDrawing={cancelDrawing}
              uploadAudio={uploadAudio}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
