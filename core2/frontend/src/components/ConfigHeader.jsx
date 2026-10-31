import React from 'react';
import EditableName from './EditableName';

// Sits directly above ConfigSliders in VoicePage: the
// device's editable name on the left, the "hide unset" toggle that filters
// ConfigSliders on the right — kept together since the toggle is really
// about the sliders right below it, not the name itself.
//
// If `types` is given (the device announces its list of valid names, e.g.
// voices), the name becomes a dropdown instead of free text.
export default function ConfigHeader({ deviceId, name, onCommand, hideUnset, onHideUnsetChange, types }) {
  const options = types && types.length > 0 ? types : null;
  // Keep showing the current value even if it's not in the list (old name).
  const values = options && name && !options.includes(name) ? [name, ...options] : options;

  return (
    <div className="config-header-row">
      {values ? (
        <select
          className="name-edit-input"
          value={name || ''}
          onChange={(e) => onCommand(deviceId, 'SET', { name: e.target.value })}
        >
          {!name && <option value="" disabled>select type</option>}
          {values.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      ) : (
        <EditableName deviceId={deviceId} name={name} onCommand={onCommand} />
      )}
      <label className="hide-unset-toggle">
        <input type="checkbox" checked={hideUnset} onChange={(e) => onHideUnsetChange(e.target.checked)} />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
        hide unset
      </label>
    </div>
  );
}
