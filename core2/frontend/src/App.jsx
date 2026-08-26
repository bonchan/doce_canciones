import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import useDevices from './hooks/useDevices';
import DeviceListPage from './pages/DeviceListPage';
import DeviceDetailPage from './pages/DeviceDetailPage';

export default function App() {
  const { devices, wsStatus, apiKey, setApiKey, error, sendCommand, drawSolarPath, cancelDrawing } = useDevices();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/devices" replace />} />
        <Route
          path="/devices"
          element={
            <DeviceListPage
              devices={devices}
              wsStatus={wsStatus}
              apiKey={apiKey}
              setApiKey={setApiKey}
              error={error}
              sendCommand={sendCommand}
            />
          }
        />
        <Route
          path="/devices/:deviceId"
          element={
            <DeviceDetailPage
              devices={devices}
              sendCommand={sendCommand}
              drawSolarPath={drawSolarPath}
              cancelDrawing={cancelDrawing}
              error={error}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
