import React, { useEffect, useRef, useState } from 'react';

// One slider per config key esp32C3_organismo exposes (see its
// organismo_config.h / the SET capability). min/max/step are placeholders —
// 0..1 is just a reasonable default for a normalized behavior parameter;
// tune any of these per-field once you know what range each one actually
// wants (e.g. duration probably wants seconds, not 0..1).
export const CONFIG_FIELDS = [
  { key: 'volume', label: 'Volumen' },
  { key: 'initialPresence', label: 'Presencia inicial' },
  { key: 'entrance', label: 'Entrada' },
  { key: 'irregularity', label: 'Irregularidad' },
  { key: 'restMovement', label: 'Descanso Movimiento' },
  { key: 'latentVolume', label: 'Volumen Latente' },
  { key: 'duration', label: 'Duracion' },
  { key: 'expansion', label: 'Expansion' },
  { key: 'contact', label: 'Contacto' },
  { key: 'airMovement', label: 'Aire Movimiento' },
  { key: 'presence', label: 'Presencia' },
  { key: 'aperture', label: 'Apertura' },
  { key: 'meeting', label: 'Encuentro' },
  { key: 'answer', label: 'Respuesta' },
  { key: 'doubt', label: 'Duda' },
  { key: 'appearance', label: 'Aparicion' },
].map((f) => ({ min: 0, max: 1, step: 0.01, ...f }));

// Slider position for a key that has never been SET on the device (its
// config value is NAN on the firmware side, so it's simply absent from
// node.config) — just a starting thumb position, not sent anywhere until
// the user actually drags it.
const DEFAULT_DRAFT_VALUE = 0.5;

// Shared by VoicePage (full device page) and VoiceCard (compact grid card)
// so the drag/commit/clear logic lives in exactly one place. Dragging only
// updates the value locally; releasing (mouseup/touchend — or keyup, for
// keyboard nudges) is what actually fires the SET command, so a live drag
// doesn't spam the broker with every intermediate step. Double-clicking a
// label clears that key back to unset (see organismo_config.h's null
// handling in handleSetCommand).
export default function ConfigSliders({ deviceId, config, onCommand, hideUnset = false }) {
  const cfg = config || {};

  // Local slider positions — what's actually drawn. Kept in sync with the
  // backend's config (below) except for whichever key is mid-drag right
  // now, so an incoming websocket update can never yank the thumb out from
  // under the user's cursor.
  const [draft, setDraft] = useState(() => {
    const initial = {};
    CONFIG_FIELDS.forEach(({ key }) => {
      initial[key] = typeof cfg[key] === 'number' ? cfg[key] : DEFAULT_DRAFT_VALUE;
    });
    return initial;
  });
  const dragKeyRef = useRef(null);

  useEffect(() => {
    setDraft((prev) => {
      const next = { ...prev };
      CONFIG_FIELDS.forEach(({ key }) => {
        if (key === dragKeyRef.current) return; // leave the in-progress drag alone
        if (typeof cfg[key] === 'number') next[key] = cfg[key];
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const commit = (key) => {
    dragKeyRef.current = null;
    onCommand(deviceId, 'SET', { [key]: draft[key] });
  };

  const clear = (key) => {
    dragKeyRef.current = null;
    setDraft((prev) => ({ ...prev, [key]: DEFAULT_DRAFT_VALUE }));
    onCommand(deviceId, 'SET', { [key]: null });
  };

  return (
    <div className="config-sliders">
      {CONFIG_FIELDS.map(({ key, label, min, max, step }) => {
        const isSet = typeof cfg[key] === 'number';
        if (hideUnset && !isSet) return null;
        return (
          <div key={key} className="config-row">
            <div className="config-row-label">
              <span
                className="config-label"
                onDoubleClick={() => clear(key)}
                title="Double-click to clear this value"
              >
                {label}
              </span>
              <span className={`config-value${isSet ? '' : ' dim'}`}>
                {isSet ? draft[key].toFixed(2) : 'not set'}
              </span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={draft[key]}
              onChange={(e) => {
                dragKeyRef.current = key;
                setDraft((prev) => ({ ...prev, [key]: parseFloat(e.target.value) }));
              }}
              onMouseUp={() => commit(key)}
              onTouchEnd={() => commit(key)}
              onKeyUp={() => commit(key)}
              className={`config-slider${isSet ? '' : ' unset'}`}
            />
          </div>
        );
      })}
    </div>
  );
}
