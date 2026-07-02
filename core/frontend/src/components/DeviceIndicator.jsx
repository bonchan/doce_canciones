import React from 'react';

export default function DeviceIndicator({ node, canvasWidth, canvasHeight }) {
  const pixelX = node.meta.position.x * canvasWidth;
  const pixelY = node.meta.position.y * canvasHeight;

  const isOnline = node.telemetry?.online !== false;

  const isIdentifying = isOnline ? node.telemetry?.status_led === 1 : false;
  const hasFreq = isOnline ? (node.telemetry?.freq || 0) > 100 : 0;
  const hasLight = isOnline ? (node.telemetry?.ldr1 || 0) > 100 : 0;

  const frequencyRadius = hasFreq ? Math.max(12, node.telemetry.freq / 20) : 0;
  const lightRadius = hasLight ? Math.max(12, node.telemetry.ldr1 / 20) : 0;

  const getNodeColor = () => {
    if (!isOnline) return '#ef4444';  // red if offline
    if (isIdentifying) return '#3b82f6';  // blue if identifying
    if (!node.meta.configured) return '#d97706'; // amber if unconfigured
    return hasFreq ? '#f472b6' : '#10b981';
  };

  return (
    <div style={{ position: 'absolute', left: `${pixelX}px`, top: `${pixelY}px`, transform: 'translate(-50%, -50%)', pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 5 }}>
      <div style={{ position: 'relative', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {hasFreq && (
          <div style={{ position: 'absolute', width: `${frequencyRadius * 2}px`, height: `${frequencyRadius * 2}px`, borderRadius: '50%', border: `2px solid ${isIdentifying ? 'rgba(59,130,246,0.5)' : 'rgba(244,114,182,0.4)'}`, background: isIdentifying ? 'rgba(59,130,246,0.05)' : 'rgba(244,114,182,0.05)', transition: 'width 0.05s ease, height 0.05s ease', boxSizing: 'border-box' }} />
        )}

        {hasLight && (
          <div style={{ position: 'absolute', width: `${lightRadius * 2}px`, height: `${lightRadius * 2}px`, borderRadius: '50%', border: `2px solid ${isIdentifying ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.72)'}`, background: 'rgba(244,114,182,0.05)', transition: 'width 0.05s ease, height 0.05s ease', boxSizing: 'border-box' }} />
        )}

        <div style={{ position: 'absolute', width: '24px', height: '24px', borderRadius: '50%', background: getNodeColor(), border: '2px solid #ffffff', boxShadow: isIdentifying ? '0 0 15px #3b82f6' : !isOnline ? '0 0 10px #ef4444' : '0 0 10px rgba(0,0,0,0.5)', boxSizing: 'border-box', transition: 'background-color 0.1s ease, box-shadow 0.1s ease' }} />
      </div>

      <div style={{ marginTop: '6px', background: 'rgba(15,23,42,0.85)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', color: isOnline ? '#f8fafc' : '#ef4444', whiteSpace: 'nowrap', border: isIdentifying ? '1px solid #3b82f6' : !isOnline ? '1px solid #ef4444' : '1px solid #334155' }}>
        {node.meta.name || node.meta.id}
      </div>
    </div>
  );
}