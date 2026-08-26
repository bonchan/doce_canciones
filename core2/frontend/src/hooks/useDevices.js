import { useState, useEffect, useCallback } from 'react';

// Falls back to whatever host the page was loaded from, so this works both
// on the NUC itself and from another machine on the gallery LAN — override
// with VITE_API_BASE in .env if the backend lives somewhere else.
const API_BASE = import.meta.env.VITE_API_BASE || `http://${window.location.hostname}:8000`;
const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Single source of truth for the live registry + command sending, shared by
// every page (list view, device detail view) so they all see the same
// devices without each opening its own websocket.
export default function useDevices() {
  const [devices, setDevices] = useState({});
  const [wsStatus, setWsStatus] = useState('Connecting...');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') || '');
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem('apiKey', apiKey);
  }, [apiKey]);

  // Initial load — /api/devices returns the registry as { device_id: {...} }
  useEffect(() => {
    fetch(`${API_BASE}/api/devices`)
      .then((res) => res.json())
      .then((data) => setDevices(data))
      .catch((err) => console.error('Error fetching devices:', err));
  }, []);

  // Live updates — backend pushes the full registry snapshot on every change
  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      ws = new WebSocket(`${WS_BASE}/ws/state`);

      ws.onopen = () => {
        if (isMounted) setWsStatus('Connected');
      };
      ws.onclose = () => {
        if (!isMounted) return;
        setWsStatus('Disconnected. Retrying...');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        if (!isMounted) return;
        const message = JSON.parse(event.data);
        if (message.type === 'STATE') {
          setDevices(message.data);
        }
      };
    }

    connect();
    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const sendCommand = useCallback(
    (deviceId, capability, params = {}) => {
      setError('');
      fetch(`${API_BASE}/api/devices/${deviceId}/command/${capability}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify(params),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        })
        .catch((err) => setError(`Command to ${deviceId} failed: ${err.message}`));
    },
    [apiKey]
  );

  // Draw-job endpoints are separate from sendCommand (not a raw device
  // capability — the backend orchestrates a whole multi-point job). No
  // body needed; the backend computes the points itself.
  const drawSolarPath = useCallback(
    (deviceId, scale = 1, date = null) => {
      setError('');
      const params = new URLSearchParams({ scale });
      if (date) params.set('date', date);  // omit entirely to let the backend default to today
      fetch(`${API_BASE}/api/devices/${deviceId}/draw/solar_path?${params}`, {
        method: 'POST',
        headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || `${res.status} ${res.statusText}`);
          }
        })
        .catch((err) => setError(`Draw solar path on ${deviceId} failed: ${err.message}`));
    },
    [apiKey]
  );

  const cancelDrawing = useCallback(
    (deviceId) => {
      setError('');
      fetch(`${API_BASE}/api/devices/${deviceId}/draw/cancel`, {
        method: 'POST',
        headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
      }).catch((err) => setError(`Cancel drawing on ${deviceId} failed: ${err.message}`));
    },
    [apiKey]
  );

  return { devices, wsStatus, apiKey, setApiKey, error, sendCommand, drawSolarPath, cancelDrawing };
}
