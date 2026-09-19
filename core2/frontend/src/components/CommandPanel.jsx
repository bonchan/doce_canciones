import React, { useState } from 'react';

// Every declared `subscribes` capability as a clickable button, plus a
// shared JSON box for that device — click a button and it fires with
// whatever's currently in the box as the command body. Used by both the
// device list cards and the per-device detail pages, so there's one place
// that owns this behavior.
export default function CommandPanel({ deviceId, capabilities, onCommand }) {
  const [paramsText, setParamsText] = useState('{}');
  const [paramsError, setParamsError] = useState('');

  if (!capabilities || capabilities.length === 0) return null;

  const fire = (capability) => {
    let params;
    try {
      params = paramsText.trim() === '' ? {} : JSON.parse(paramsText);
    } catch (e) {
      setParamsError('Invalid JSON');
      return;
    }
    setParamsError('');
    onCommand(deviceId, capability, params);
  };

  return (
    <div className="cmd-panel">
      <div className="tags">
        {capabilities.map((c) => (
          <button key={c} className="tag tag-btn" onClick={() => fire(c)} title={`Send ${c} with the JSON below`}>
            {c}
          </button>
        ))}
      </div>
      <textarea
        className="params-input"
        rows={2}
        value={paramsText}
        onChange={(e) => setParamsText(e.target.value)}
        placeholder='{"duration": 2000}'
        spellCheck={false}
      />
      {paramsError && <div className="params-error">{paramsError}</div>}
    </div>
  );
}
