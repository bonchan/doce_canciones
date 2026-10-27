import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import useDevices from './hooks/useDevices';
import useUpdateBadge from './hooks/useUpdateBadge';
import NavBar from './components/NavBar';
import DevicesPage from './pages/DevicesPage';
import SystemPage from './pages/SystemPage';

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
    deleteDevice,
  } = useDevices();
  const updateAvailable = useUpdateBadge();

  return (
    <BrowserRouter>
      <NavBar wsStatus={wsStatus} updateAvailable={updateAvailable} />
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
              deleteDevice={deleteDevice}
            />
          }
        />
        <Route path="/system" element={<SystemPage apiKey={apiKey} setApiKey={setApiKey} />} />
      </Routes>
    </BrowserRouter>
  );
}
