import React from 'react';
import EditableName from './EditableName';

// Sits directly above ConfigSliders in both VoiceCard and VoicePage: the
// device's editable name on the left, the "hide unset" toggle that filters
// ConfigSliders on the right — kept together since the toggle is really
// about the sliders right below it, not the name itself.
export default function ConfigHeader({ deviceId, name, onCommand, hideUnset, onHideUnsetChange }) {
  return (
    <div className="config-header-row">
      <EditableName deviceId={deviceId} name={name} onCommand={onCommand} />
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
