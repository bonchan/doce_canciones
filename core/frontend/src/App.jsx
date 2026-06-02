import React, { useState, useEffect, useRef } from 'react';
import DeviceIndicator from './components/DeviceIndicator';

export default function App() {
  const [devices, setDevices] = useState({});
  const [wsStatus, setWsStatus] = useState("Connecting...");
  const canvasRef = useRef(null);
  const dragTargetRef = useRef(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [editingId, setEditingId] = useState(null);
  const [identifyingId, setIdentifyingId] = useState(null);

  // 1. Initial Load
  useEffect(() => {
    fetch('http://localhost:8000/api/devices')
      .then(res => res.json())
      .then(data => {
        const deviceMap = {};
        data.forEach(dev => {
          deviceMap[dev.id] = {
            meta: dev,
            telemetry: dev.last_seen_telemetry || { ldr: 0, led_bright: 0, speaker_hz: 0, wifi_rssi: 0 }
          };
        });
        setDevices(deviceMap);
      })
      .catch(err => console.error("Error fetching initial device log:", err));
  }, []);

  // 2. WebSocket Stream
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8000/ws/telemetry');
    ws.onopen = () => setWsStatus("Connected");
    ws.onclose = () => setWsStatus("Disconnected. Retrying...");

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "TELEMETRY_UPDATE") {
        setDevices(prevDevices => {
          if (dragTargetRef.current === message.chip_id) {
            return {
              ...prevDevices,
              [message.chip_id]: {
                ...prevDevices[message.chip_id],
                telemetry: message.data
              }
            };
          }
          return {
            ...prevDevices,
            [message.chip_id]: {
              meta: message.device_meta,
              telemetry: message.data
            }
          };
        });
      }
    };
    return () => ws.close();
  }, []);

  // 3. Database Save Dispatch
  const saveDeviceConfigToDatabase = (chipId, name, x, y, z) => {
    fetch(`http://localhost:8000/api/devices/${chipId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        position: { x: x, y: y, z: z }
      })
    })
      .then(() => {
        // Optimistically keep the local metadata config matching database schemas
        setDevices(prev => {
          if (!prev[chipId]) return prev;
          return {
            ...prev,
            [chipId]: {
              ...prev[chipId],
              meta: {
                ...prev[chipId].meta,
                name: name,
                configured: true,
                position: { x: x, y: y, z: z }
              }
            }
          };
        });
      })
      .catch(err => console.error("Database sync failed:", err));
  };

  const toggleDeviceLed = (chipId, turnOn) => {
    setIdentifyingId(turnOn ? chipId : null);
    fetch(`http://localhost:8000/api/devices/${chipId}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: turnOn ? "on" : "off" })
    }).catch(err => console.error("Failed to send identify payload:", err));
  };

  // 4. Mouse Input Event Listeners
  const handleMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    for (const node of Object.values(devices)) {
      const pixelX = node.meta.position.x * canvas.width;
      const pixelY = node.meta.position.y * canvas.height;
      const distance = Math.hypot(mouseX - pixelX, mouseY - pixelY);

      if (distance < 25) {
        dragTargetRef.current = node.meta.id;

        // Calculate exactly where the mouse clicked relative to the TRUE circle center point
        dragOffsetRef.current = {
          x: mouseX - pixelX,
          y: mouseY - pixelY
        };
        break;
      }
    }
  };

  const handleMouseMove = (e) => {
    if (!dragTargetRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Subtract the anchor offset so your mouse pointer holds the exact spot you grabbed on the circle
    const correctedX = mouseX - dragOffsetRef.current.x;
    const correctedY = mouseY - dragOffsetRef.current.y;

    // Normalize back to 0.0 - 1.0 boundary values safely
    const normX = Math.max(0, Math.min(1, correctedX / canvas.width));
    const normY = Math.max(0, Math.min(1, correctedY / canvas.height));

    setDevices(prev => ({
      ...prev,
      [dragTargetRef.current]: {
        ...prev[dragTargetRef.current],
        meta: {
          ...prev[dragTargetRef.current].meta,
          position: { ...prev[dragTargetRef.current].meta.position, x: normX, y: normY }
        }
      }
    }));
  };

  const handleMouseUp = () => {
    if (!dragTargetRef.current) return;

    const chipId = dragTargetRef.current;
    const targetNode = devices[chipId];
    dragTargetRef.current = null;

    saveDeviceConfigToDatabase(
      targetNode.meta.id,
      targetNode.meta.name,
      targetNode.meta.position.x,
      targetNode.meta.position.y,
      targetNode.meta.position.z
    );
  };

  return (
    <div style={{ display: 'flex', height: '100vh', margin: -20, overflow: 'hidden' }}>

      <aside style={{ width: '320px', borderRight: '1px solid #374151', background: '#111827', padding: '20px', overflowY: 'auto' }}>
        <div className="header" style={{ display: 'block', borderBottom: '1px solid #27272a', paddingBottom: '10px', marginBottom: '20px' }}>
          <h2 style={{ color: '#10b981', margin: 0, fontSize: '20px' }}>Brain Core</h2>
          <div className={`status-badge ${wsStatus === "Connected" ? "connected" : "disconnected"}`} style={{ display: 'inline-block', marginTop: '5px' }}>
            {wsStatus}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {Object.values(devices).map((node) => (
            <div
              key={node.meta.id}
              className={`card ${!node.meta.configured ? 'unconfigured' : ''}`}
              style={{ padding: '12px', borderRadius: '8px', background: '#1f2937', border: '1px solid #374151' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>

                {/* --- DOUBLE CLICK INLINE EDITOR EDITION --- */}
                {editingId === node.meta.id ? (
                  <input
                    type="text"
                    defaultValue={node.meta.name}
                    autoFocus
                    style={{
                      background: '#111827',
                      border: '1px solid #10b981',
                      color: 'white',
                      fontSize: '14px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      width: '140px'
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        saveDeviceConfigToDatabase(node.meta.id, e.target.value, node.meta.position.x, node.meta.position.y, node.meta.position.z);
                        setEditingId(null);
                      }
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={(e) => {
                      saveDeviceConfigToDatabase(node.meta.id, e.target.value, node.meta.position.x, node.meta.position.y, node.meta.position.z);
                      setEditingId(null);
                    }}
                  />
                ) : (
                  <strong
                    style={{ fontSize: '14px', cursor: 'pointer' }}
                    onDoubleClick={() => setEditingId(node.meta.id)}
                    title="Double-click to edit friendly name"
                  >
                    {node.meta.configured ? node.meta.name ? node.meta.name : 'NONAME' : node.meta.id}
                  </strong>
                )}

                {node.meta.configured && (
                  <span style={{ color: '#8a8988', fontSize: '10px', fontWeight: 'bold' }}>{node.meta.id}</span>
                )}
                {!node.meta.configured && (
                  <span style={{ color: '#fbbf24', fontSize: '10px', fontWeight: 'bold' }}>NEW</span>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af', marginTop: '8px', background: '#111827', padding: '6px', borderRadius: '4px' }}>
                <span>LDR: <span style={{ color: '#ffffff' }}>{node.telemetry.ldr}</span></span>
                <span>Tone: <span style={{ color: '#f472b6' }}>{node.telemetry.speaker_hz}Hz</span></span>
                <span>RSSI: <span style={{ color: '#34d399' }}>{node.telemetry.wifi_rssi}</span></span>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                <button
                  onMouseDown={() => toggleDeviceLed(node.meta.id, true)}
                  onMouseUp={() => toggleDeviceLed(node.meta.id, false)}
                  onMouseLeave={() => toggleDeviceLed(node.meta.id, false)}
                  style={{
                    flex: 1,
                    background: identifyingId === node.meta.id ? '#2563eb' : '#ebb625',
                    border: 'none',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  Hold to Identify Node 🔦
                </button>
              </div>

              {/* <span style={{ fontSize: '15px', color: '#4b5563', fontFamily: 'monospace', display: 'block', marginTop: '4px' }}>
                {JSON.stringify(node.meta.position)}
              </span> */}
            </div>
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, position: 'relative', background: '#0f172a', padding: '20px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '10px', fontSize: '12px', color: '#6b7280' }}>
          Drag nodes across the canvas layout window. Data commits to disk on release.
        </div>

        <div style={{
          position: 'relative',
          width: '800px',      // Force the container to match the canvas size exactly
          height: '600px',     // Force the container to match the canvas size exactly
          background: '#020617',
          borderRadius: '12px',
          border: '1px solid #1e293b',
          overflow: 'hidden'
        }}>
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '800px',
              height: '600px',
              background: 'transparent',
              cursor: 'move',
              zIndex: 1
            }}
          />

          {/* Indicators now render naturally ON TOP of the canvas layer */}
          {canvasRef.current && Object.values(devices).map((node) => (
            <DeviceIndicator
              key={node.meta.id}
              node={node}
              canvasWidth={canvasRef.current.width}
              canvasHeight={canvasRef.current.height}
              isIdentifying={identifyingId === node.meta.id}
            />
          ))}
        </div>
      </main>

    </div>
  );
}