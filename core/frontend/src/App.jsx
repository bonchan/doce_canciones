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
            telemetry: dev.telemetry || { ldr1: 0, ldr2: 0, freq: 0, wifi_rssi: 0, online: false }
          };
        });
        setDevices(deviceMap);
      })
      .catch(err => console.error("Error fetching initial devices:", err));
  }, []);

  // 2. WebSocket Stream
  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;

      ws = new WebSocket('ws://localhost:8000/ws/telemetry');
      
      ws.onopen = () => {
        if (isMounted) setWsStatus("Connected");
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsStatus("Disconnected. Retrying...");
        
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        const message = JSON.parse(event.data);

        if (message.type === "CONFIG") {
          // [{id, name, x, y}, ...]
          message.data.forEach(cfg => {
            setDevices(prev => {
              if (!prev[cfg.id]) return prev;
              return {
                ...prev,
                [cfg.id]: {
                  ...prev[cfg.id],
                  meta: {
                    ...prev[cfg.id].meta,
                    fw: cfg.fw,
                    name: cfg.name,
                    position: { x: cfg.x, y: cfg.y, z: prev[cfg.id].meta?.position?.z || 0 }
                  }
                }
              };
            });
          });
        }

        else if (message.type === "STATE_UPDATE") {
          setDevices(prev => {
            const updated = { ...prev };
            Object.entries(message.data).forEach(([chipId, telemetry]) => {
              if (dragTargetRef.current === chipId) {
                // don't update position while dragging
                updated[chipId] = {
                  ...updated[chipId],
                  telemetry
                };
              } else {
                updated[chipId] = {
                  meta: updated[chipId]?.meta || { id: chipId, name: chipId, configured: false, position: { x: 0.5, y: 0.5, z: 0 } },
                  telemetry
                };
              }
            });
            return updated;
          });
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

  // 3. Save config
  const saveDeviceConfigToDatabase = (chipId, name, x, y, z) => {
    fetch(`http://localhost:8000/api/devices/${chipId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, position: { x, y, z } })
    })
      .then(() => {
        setDevices(prev => {
          if (!prev[chipId]) return prev;
          return {
            ...prev,
            [chipId]: {
              ...prev[chipId],
              meta: {
                ...prev[chipId].meta,
                name,
                configured: true,
                position: { x, y, z }
              }
            }
          };
        });
      })
      .catch(err => console.error("Config save failed:", err));
  };

  const identifyDevice = (chipId) => {
    // setIdentifyingId(turnOn ? chipId : null);
    fetch(`http://localhost:8000/api/devices/${chipId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: "IDENTIFY",
        params: { duration: 2000 }
      })
    }).catch(err => console.error("Command failed:", err));
  };

  const updateDevice = (chipId, scriptName) => {
    // setIdentifyingId(turnOn ? chipId : null);
    fetch(`http://localhost:8000/api/devices/${chipId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: "UPDATE",
        params: { url: `http://192.168.200.55:5000/files/${scriptName}.ino.bin` }
      })
    }).catch(err => console.error("Command failed:", err));
  };

  // 5. Drag handlers
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
        dragOffsetRef.current = { x: mouseX - pixelX, y: mouseY - pixelY };
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
    const normX = Math.max(0, Math.min(1, (mouseX - dragOffsetRef.current.x) / canvas.width));
    const normY = Math.max(0, Math.min(1, (mouseY - dragOffsetRef.current.y) / canvas.height));

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
    const node = devices[chipId];
    dragTargetRef.current = null;
    saveDeviceConfigToDatabase(chipId, node.meta.name, node.meta.position.x, node.meta.position.y, node.meta.position.z);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', margin: -20, overflow: 'hidden' }}>

      <aside style={{ minWidth: '350px', borderRight: '1px solid #374151', background: '#111827', padding: '20px', overflowY: 'auto' }}>
        <div className="header" style={{ display: 'block', borderBottom: '1px solid #27272a', paddingBottom: '10px', marginBottom: '20px' }}>
          <h2 style={{ color: '#10b981', margin: 0, fontSize: '20px' }}>Brain Core</h2>
          <div className={`status-badge ${wsStatus === "Connected" ? "connected" : "disconnected"}`} style={{ display: 'inline-block', marginTop: '5px' }}>
            {wsStatus}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {Object.values(devices)
            .sort((a, b) => Number(b.meta?.device_type) - Number(a.meta?.device_type))
            .sort((a, b) => Number(b.telemetry?.online) - Number(a.telemetry?.online))
            .map((node) => (
              <div
                key={node.meta.id}
                className={`card ${!node.meta.configured ? 'unconfigured' : ''}`}
                style={{ padding: '12px', borderRadius: '8px', background: `${node.meta?.device_type === "satellite" ? '#333d2a' : '#1f2937'}`, border: `1px solid ${node.telemetry?.online === false ? '#dc2626' : '#374151'}` }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>

                  {editingId === node.meta.id ? (
                    <input
                      type="text"
                      defaultValue={node.meta.name}
                      autoFocus
                      style={{ background: '#111827', border: '1px solid #10b981', color: 'white', fontSize: '14px', padding: '2px 6px', borderRadius: '4px', width: '140px' }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { saveDeviceConfigToDatabase(node.meta.id, e.target.value, node.meta.position.x, node.meta.position.y, node.meta.position.z); setEditingId(null); }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={(e) => { saveDeviceConfigToDatabase(node.meta.id, e.target.value, node.meta.position.x, node.meta.position.y, node.meta.position.z); setEditingId(null); }}
                    />
                  ) : (
                    <strong style={{ fontSize: '14px', cursor: 'pointer' }} onDoubleClick={() => setEditingId(node.meta.id)} title="Double-click to rename">
                      {node.meta.configured ? (node.meta.name || 'NONAME') : node.meta.id}
                    </strong>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {/* online indicator */}
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: node.telemetry?.online === false ? '#ef4444' : '#10b981' }} />
                    {node.meta.configured && <span style={{ color: '#8a8988', fontSize: '10px' }}>{node.meta.id}</span>}
                    {!node.meta.configured && <span style={{ color: '#fbbf24', fontSize: '10px', fontWeight: 'bold' }}>NEW</span>}
                  </div>
                </div>

                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px', background: '#111827', padding: '6px', borderRadius: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Firmware: <span style={{ color: '#fff' }}>{node.meta.fw}</span></span>
                    <span>Script: <span style={{ color: '#fff' }}>{node.meta.sn}</span></span>
                  </div>
                  {
                    node.meta?.device_type === "satellite" &&
                    <button
                      onClick={() => updateDevice(node.meta.id, node.meta.sn)}
                      style={{ marginTop: '6px', width: '100%', background: '#1d4ed8', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
                    >
                      Update Firmware
                    </button>
                  }
                </div>
                {
                  node.meta?.device_type === "satellite" ?
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af', marginTop: '8px', background: '#111827', padding: '6px', borderRadius: '4px' }}>
                      <span>LDR1: <span style={{ color: '#fff' }}>{node.telemetry?.ldr1 ?? '-'}</span></span>
                      <span>LDR2: <span style={{ color: '#fff' }}>{node.telemetry?.ldr2 ?? '-'}</span></span>
                      <span>Freq: <span style={{ color: '#f472b6' }}>{node.telemetry?.freq ?? '-'}Hz</span></span>
                      <span>RSSI: <span style={{ color: '#34d399' }}>{node.telemetry?.wifi_rssi ?? '-'}</span></span>
                      <span>millis: <span style={{ color: '#34d399' }}>{node.telemetry?.millis ?? '-'}</span></span>
                    </div>
                    :
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af', marginTop: '8px', background: '#111827', padding: '6px', borderRadius: '4px', overflow: 'auto' }}>
                      <span>telemetry: <span style={{ color: '#fff' }}>{JSON.stringify(node.telemetry) ?? '-'}</span></span>
                    </div>
                }
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                  <button
                    onClick={() => identifyDevice(node.meta.id)}
                    style={{ flex: 1, color: node.telemetry?.status_led === 1 ? '#ffff' : '#000000', background: node.telemetry?.status_led === 1 ? '#2563eb' : '#ebb625', border: 'none', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    {node.telemetry?.status_led === 1 ? "Identified!" : "Click to Identify"}
                  </button>
                </div>
              </div>
            ))}
        </div>
      </aside>

      <main style={{ flex: 1, position: 'relative', background: '#0f172a', padding: '20px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '10px', fontSize: '12px', color: '#6b7280' }}>
          Drag nodes across the canvas. Releases commit to disk.
        </div>

        <div style={{ position: 'relative', width: '800px', height: '600px', background: '#020617', borderRadius: '12px', border: '1px solid #1e293b', overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ position: 'absolute', top: 0, left: 0, width: '800px', height: '600px', cursor: 'move', zIndex: 1 }}
          />

          {canvasRef.current && Object.values(devices).map((node) => (
            <DeviceIndicator
              key={node.meta.id}
              node={node}
              canvasWidth={canvasRef.current.width}
              canvasHeight={canvasRef.current.height}
            />
          ))}
        </div>
      </main>
    </div>
  );
}