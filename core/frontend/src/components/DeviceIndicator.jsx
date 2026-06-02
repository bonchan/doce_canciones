import React from 'react';

export default function DeviceIndicator({ node, canvasWidth, canvasHeight, isIdentifying }) {
  // Translate the normalized coordinates (0.0 to 1.0) back to pixel layout positions
  const pixelX = node.meta.position.x * canvasWidth;
  const pixelY = node.meta.position.y * canvasHeight;

  const hasTone = node.telemetry.speaker_hz > 100;
  const hasLight = node.telemetry.ldr > 100;

  const FREQ_CONSTANT = 20;
  const frequencyRadius = node.telemetry.speaker_hz > 100
    ? Math.max(12, node.telemetry.speaker_hz / FREQ_CONSTANT)
    : 0;

  const LIGHTCONSTANT = 20;
  const lightRadius = node.telemetry.ldr > 100
    ? Math.max(12, node.telemetry.ldr / LIGHTCONSTANT)
    : 0;

  const getNodeColor = () => {
    if (isIdentifying) return '#3b82f6'; // Neon Blue while identification button is held down
    if (!node.meta.configured) return '#d97706'; // Amber for unconfigured nodes
    return hasTone ? '#f472b6' : '#10b981'; // Pink if active tone, Emerald if silent
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${pixelX}px`,
        top: `${pixelY}px`,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        zIndex: 5
      }}
    >
      <div style={{ position: 'relative', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {/* Dynamic Telemetry Flash Ring */}
        {hasTone && (
          <div
            style={{
              position: 'absolute',
              width: `${frequencyRadius * 2}px`,
              height: `${frequencyRadius * 2}px`,
              borderRadius: '50%',
              // Make the sound wave flash blue too if identifying
              border: `2px solid ${isIdentifying ? 'rgba(59, 130, 246, 0.5)' : 'rgba(244, 114, 182, 0.4)'}`,
              background: isIdentifying ? 'rgba(59, 130, 246, 0.05)' : 'rgba(244, 114, 182, 0.05)',
              transition: 'width 0.05s ease, height 0.05s ease',
              boxSizing: 'border-box'
            }}
          />
        )}

        {hasLight && (
          <div
            style={{
              position: 'absolute',
              width: `${lightRadius * 2}px`,
              height: `${lightRadius * 2}px`,
              borderRadius: '50%',
              // Make the sound wave flash blue too if identifying
              border: `2px solid ${isIdentifying ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255, 255, 255, 0.72)'}`,
              background: isIdentifying ? 'rgba(59, 130, 246, 0.05)' : 'rgba(244, 114, 182, 0.05)',
              transition: 'width 0.05s ease, height 0.05s ease',
              boxSizing: 'border-box'
            }}
          />
        )}

        {/* Target Node Center Core */}
        <div
          style={{
            position: 'absolute',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: getNodeColor(),
            border: '2px solid #ffffff',
            boxShadow: isIdentifying ? '0 0 15px #3b82f6' : '0 0 10px rgba(0,0,0,0.5)',
            boxSizing: 'border-box',
            transition: 'background-color 0.1s ease, box-shadow 0.1s ease'
          }}
        />
      </div>

      {/* Label Identifier Tags */}
      <div
        style={{
          marginTop: '6px',
          background: 'rgba(15, 23, 42, 0.85)',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 'bold',
          color: '#f8fafc',
          whiteSpace: 'nowrap',
          border: isIdentifying ? '1px solid #3b82f6' : '1px solid #334155'
        }}
      >
        {node.meta.name}
      </div>
    </div>
  );
}