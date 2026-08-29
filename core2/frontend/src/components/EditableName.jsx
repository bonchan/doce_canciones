import React, { useEffect, useRef, useState } from 'react';

// Double-click the name to rename it; Enter commits (sends SET
// {name: <value>}), Escape or clicking away without pressing Enter cancels
// and reverts to whatever the config currently says. An empty/unchanged
// value never gets sent — it just reverts, same as a cancel.
export default function EditableName({ deviceId, name, onCommand }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name || '');
  const inputRef = useRef(null);

  // Stay in sync with the confirmed config value whenever it changes from
  // outside (another client renamed it, or our own SET round-tripped back)
  // — but only while not actively editing, so an in-progress edit is never
  // clobbered out from under the user.
  useEffect(() => {
    if (!editing) setDraft(name || '');
  }, [name, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== name) {
      onCommand(deviceId, 'SET', { name: trimmed });
    } else {
      setDraft(name || '');
    }
  };

  const cancel = () => {
    setDraft(name || '');
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="name-edit-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        onBlur={cancel}
      />
    );
  }

  return (
    <span className="device-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
      {name || 'unnamed'}
    </span>
  );
}
