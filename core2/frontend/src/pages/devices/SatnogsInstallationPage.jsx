import { useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// installation.satnogs — the SatNOGS installation's server (C12/SatNOGS poc/installationwebapp):
// one shared timeline of satellite passes that every display (globes, reception, schedule,
// telemetry, signal) draws from. Its displays and the computers they run on are in the same zone
// ("satnogs"), each computer as a computer.satnogs device with its own page.
//
//   SKIP / RESTART      the pass on air
//   RELOAD / IDENTIFY   every display, or {"ids": [...]} only some
//   SETTINGS            the operator page's settings, e.g. {"speed": 4}, {"language": "es"},
//                       {"sky": 50} (% of the passes with a photo of the sky from below),
//                       {"ghosts": {"tear": {"delay": 6}}} (only what's in it changes)
//   QUEUE               {"pass_id": 10842543}: that pass right after the one on air
//   GHOST               a ghost test, now on every display: {"kind": "tear"}, {"kinds": [...]},
//                       or {} for all of them
//   CENIT               a test of the look-up moment (the plain sky photo), now on every display
//
// The language list comes from its announce (node.meta.languages), so adding a language file
// there makes a button appear here.

const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 2px' };
const ON = { outline: '2px solid currentColor', opacity: 1 };
const TABLE = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const CELL = { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #333' };
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64];

// the reception ghosts: the sky photo breaking into the signal, each kind on its own
const GHOSTS = [
  ['tear', 'Torn lines', 'NOAA'],
  ['echo', 'Echo', 'NOAA'],
  ['roll', 'Rolling frame', 'NOAA'],
  ['blocks', 'Blocks', 'METEOR'],
  ['smear', 'Smear', 'METEOR'],
  ['mosaic', 'Mosaic', 'METEOR'],
];
const APPEAR = [
  ['low', 'more with the satellite low'],
  ['high', 'more with the satellite high'],
  ['steady', 'steady'],
  ['off', 'off'],
];

// the look-up moment: the plain sky photo, full screen, at the top of a pass with one
const CENIT_FIELDS = [
  // key, label, min, max, step, slider (%) or a number (s)
  ['fadeIn', 'Fade in (s)', 0, 30, 0.1, false],
  ['hold', 'Hold, at the top of the pass (s)', 0, 120, 0.5, false],
  ['fadeOut', 'Fade out (s)', 0, 30, 0.1, false],
  ['opacity', 'Opacity', 0, 100, 5, true],
  ['zoom', 'Zoom', 100, 300, 5, true],
  ['drift', 'Drift with the wind', 0, 20, 0.5, true],
  ['minPass', 'Only on passes longer than (s)', 0, 600, 1, false],
];

const PHASES = {
  waiting: 'waiting for the next pass',
  approach: 'acquiring',
  pass: 'receiving',
  depart: 'satellite gone (LOS)',
  idle: 'no passes',
};

function clock(seconds) {
  if (seconds == null) return '-';
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Showing({ on }) {
  return (
    <span title={on ? 'connected, on screen and drawing' : 'not drawing (closed, hidden, frozen or disconnected)'}
      style={{ color: on ? '#34d399' : '#f87171' }}>
      {on ? '● showing' : '○ not showing'}
    </span>
  );
}

// The look-up moment's section: on / off, a test, and its fields. A number is sent when it's
// done (Enter, leaving it), a slider when it's let go; what was sent shows until the telemetry
// (every 3 s) changes.
function CenitSection({ c, settings, cmd }) {
  const [drafts, setDrafts] = useState({});
  const value = (key) => {
    const d = drafts[key];
    return d && (!d.sent || c?.[key] === d.liveAtSend) ? d.value : c?.[key];
  };
  const edit = (key, v) => setDrafts((x) => ({ ...x, [key]: { value: v } }));
  const send = (key, min, max) => {
    const d = drafts[key];
    if (!d || d.sent) return; // nothing new
    const n = d.value === '' ? NaN : Number(d.value);
    if (!Number.isFinite(n)) {
      setDrafts((x) => ({ ...x, [key]: undefined }));
      return;
    }
    const v = Math.min(max, Math.max(min, n));
    settings({ cenit: { [key]: v } });
    setDrafts((x) => ({ ...x, [key]: { value: v, sent: true, liveAtSend: c?.[key] } }));
  };

  return (
    <section className="card">
      <h3>Look up</h3>
      <p className="dim">
        At the top of a pass with a sky photo every screen but the globes shows the photo plain, full
        screen, then lets it go. A test shows it right away on every screen with these settings, even
        switched off.
      </p>
      {c ? (
        <>
          <div style={ROW}>
            <button className="jog-btn" style={c.on ? ON : null} onClick={() => settings({ cenit: { on: !c.on } })}>
              Look up {c.on ? 'on' : 'off'}
            </button>
            <button className="jog-btn" onClick={() => cmd('CENIT')}>Test now</button>
          </div>
          <table style={{ ...TABLE, opacity: c.on ? 1 : 0.6 }}>
            <tbody>
              {CENIT_FIELDS.map(([key, label, min, max, step, slider]) => {
                const v = value(key);
                return (
                  <tr key={key}>
                    <td style={CELL}>{label}</td>
                    <td style={CELL}>
                      {slider ? (
                        <>
                          <input type="range" min={min} max={max} step={step} value={v ?? min}
                            style={{ width: 200, verticalAlign: 'middle' }}
                            onChange={(e) => edit(key, Number(e.target.value))}
                            onPointerUp={() => send(key, min, max)} onKeyUp={() => send(key, min, max)}
                            onBlur={() => send(key, min, max)} />
                          {' '}<b>{v}%</b>
                        </>
                      ) : (
                        <input type="number" min={min} max={max} step={step} value={v ?? ''} style={{ width: 80 }}
                          onChange={(e) => edit(key, e.target.value)}
                          onBlur={() => send(key, min, max)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p className="dim">Not in the telemetry yet (an older server).</p>
      )}
    </section>
  );
}

export default function SatnogsInstallationPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const t = node.telemetry || {};
  const languages = meta.languages || [];
  const displays = t.displays || [];
  const cmd = (cap, params = {}) => sendCommand(node.device_id, cap, params);
  const settings = (patch) => cmd('SETTINGS', patch);
  // the sky slider: sent when it's let go, not on every step of the drag
  const [skyDraft, setSkyDraft] = useState(null);
  const sky = skyDraft ?? t.sky ?? 100;
  const sendSky = () => {
    if (skyDraft != null) settings({ sky: skyDraft });
    setSkyDraft(null);
  };
  // The ghosts' fields as edited here: a number is sent when it's done (Enter, leaving it), a
  // slider when it's let go. What was sent shows until the telemetry (every 3 s) changes.
  const [ghostDraft, setGhostDraft] = useState({});
  const liveGhost = (kind, field) => t.ghosts?.[kind]?.[field];
  const ghostValue = (kind, field) => {
    const d = ghostDraft[`${kind}.${field}`];
    const live = liveGhost(kind, field);
    return d && (!d.sent || live === d.liveAtSend) ? d.value : live;
  };
  const editGhost = (kind, field, value) => setGhostDraft((d) => ({ ...d, [`${kind}.${field}`]: { value } }));
  const sendGhost = (kind, field, value) => {
    const key = `${kind}.${field}`;
    const d = ghostDraft[key];
    if (value === undefined) {
      if (!d || d.sent) return; // nothing new
      value = d.value;
    }
    if (field !== 'appear') {
      value = value === '' ? NaN : Number(value);
      if (!Number.isFinite(value)) {
        setGhostDraft((x) => ({ ...x, [key]: undefined }));
        return;
      }
      const [min, max] = field === 'delay' ? [0.5, 600] : [0, 500]; // as the server keeps them
      value = Math.min(max, Math.max(min, value));
    }
    settings({ ghosts: { [kind]: { [field]: value } } });
    setGhostDraft((x) => ({ ...x, [key]: { value, sent: true, liveAtSend: liveGhost(kind, field) } }));
  };

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>SatNOGS installation <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>FW: <b>{node.fw || '-'}</b></span>
        <span>Library: <b>{t.passes ?? '-'}</b> passes from <b>{t.stations ?? '-'}</b> stations</span>
        <span>Screens showing: <b>{t.displays_showing ?? '-'} / {t.displays_connected ?? '-'}</b></span>
      </div>

      <section className="card">
        <h3>On air</h3>
        {t.satellite ? (
          <>
            <p>
              <b>{t.satellite}</b> recorded at <b>{t.station || 'unknown station'}</b> &mdash; {PHASES[t.phase] || t.phase}
              {t.phase === 'pass' ? ` ${t.progress}%, LOS in ${clock(t.los_in)}` : ''}
              {t.phase === 'waiting' || t.phase === 'approach' ? `, AOS in ${clock(t.aos_in)}` : ''}
            </p>
            <div style={{ height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${t.progress || 0}%`, height: '100%', background: '#f59e0b' }} />
            </div>
            {t.sky_photo && <p className="dim">Its sky: {t.sky_photo}</p>}
            {t.next_satellite && (
              <p className="dim">Next: {t.next_satellite}, AOS in {clock(t.next_aos_in)}</p>
            )}
          </>
        ) : (
          <p className="dim">{PHASES.idle}</p>
        )}
        <div style={ROW}>
          <button className="jog-btn" onClick={() => cmd('SKIP')}>Skip to the next pass</button>
          <button className="jog-btn" onClick={() => cmd('RESTART')}>Restart this pass</button>
          <button className="jog-btn" title="Every display shows its name for a few seconds" onClick={() => cmd('IDENTIFY')}>
            Identify displays
          </button>
          <button className="jog-btn" onClick={() => cmd('RELOAD')}>Reload displays</button>
        </div>
      </section>

      <section className="card">
        <h3>Settings</h3>
        <p className="dim">Live on every display, and saved into installation.json.</p>
        <div className="dim">Speed (1 = real time)</div>
        <div style={ROW}>
          {SPEEDS.map((v) => (
            <button key={v} className="jog-btn" style={t.speed === v ? ON : null} onClick={() => settings({ speed: v })}>
              {v}&times;
            </button>
          ))}
        </div>
        <div className="dim">Display language</div>
        <div style={ROW}>
          {languages.map((l) => (
            <button key={l.code} className="jog-btn" style={t.language === l.code ? ON : null}
              onClick={() => settings({ language: l.code })}>
              {l.name}
            </button>
          ))}
          {languages.length === 0 && <span className="dim">not announced yet</span>}
        </div>
        <div style={ROW}>
          <button className="jog-btn" style={t.phrases ? ON : null} onClick={() => settings({ phrases: !t.phrases })}
            title="Words around the Earth on the globes, arriving in the image, the waterfall and the constellation">
            Phrases {t.phrases ? 'on' : 'off'}
          </button>
          <button className="jog-btn" style={t.hide_cursor ? ON : null} onClick={() => settings({ hideCursor: !t.hide_cursor })}>
            Hide mouse pointer {t.hide_cursor ? 'on' : 'off'}
          </button>
          <button className="jog-btn" style={t.imagery === 'natural' ? ON : null}
            title="Natural Earth: offline. Esri: satellite photos from the internet"
            onClick={() => settings({ imagery: t.imagery === 'natural' ? 'esri' : 'natural' })}>
            Map: {t.imagery === 'natural' ? 'offline' : 'Esri (internet)'}
          </button>
        </div>
        <div className="dim">Sky: passes with a photo of the sky from below (0 = none, 100 = all)</div>
        <div style={{ ...ROW, alignItems: 'center' }}>
          <input type="range" min={0} max={100} step={5} value={sky} style={{ flex: '1 1 200px', maxWidth: 360 }}
            onChange={(e) => setSkyDraft(Number(e.target.value))}
            onPointerUp={sendSky} onKeyUp={sendSky} onBlur={sendSky} />
          <b>{sky}%</b>
          {t.sky_photos != null && <span className="dim">{t.sky_photos} photos</span>}
        </div>
        <div className="dim" style={{ marginTop: 12 }}>
          Ghosts: the sky photo breaking into the signal, each kind on its own: when it appears, every
          how many seconds on average (for low / high, where there are most) and how strongly (100% as
          designed, 0 to 500). A test shows it right away on every display, at its prominence, even
          switched off.
        </div>
        <div style={ROW}>
          <button className="jog-btn" style={t.ghosts_on !== false ? ON : null}
            onClick={() => settings({ ghostsOn: t.ghosts_on === false })}>
            Ghosts {t.ghosts_on !== false ? 'on' : 'off'}
          </button>
          <button className="jog-btn" onClick={() => cmd('GHOST')}>Test all now</button>
        </div>
        {t.ghosts ? (
          <table style={{ ...TABLE, opacity: t.ghosts_on === false ? 0.6 : 1 }}>
            <thead>
              <tr>
                {['', 'appears', 'every (s)', 'prominence', ''].map((h, i) => <th key={i} style={CELL}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {GHOSTS.map(([kind, name, family]) => {
                const appear = ghostValue(kind, 'appear') ?? 'low';
                const delay = ghostValue(kind, 'delay');
                const prominence = ghostValue(kind, 'prominence') ?? 100;
                return (
                  <tr key={kind} style={appear === 'off' ? { opacity: 0.5 } : null}>
                    <td style={CELL}>{name} <span className="dim">{family}</span></td>
                    <td style={CELL}>
                      <select value={appear} onChange={(e) => sendGhost(kind, 'appear', e.target.value)}>
                        {APPEAR.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </td>
                    <td style={CELL}>
                      <input type="number" min={0.5} max={600} step={0.5} value={delay ?? ''} style={{ width: 70 }}
                        onChange={(e) => editGhost(kind, 'delay', e.target.value)}
                        onBlur={() => sendGhost(kind, 'delay')}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                    </td>
                    <td style={CELL}>
                      <input type="range" min={0} max={500} step={10} value={prominence} style={{ width: 160, verticalAlign: 'middle' }}
                        onChange={(e) => editGhost(kind, 'prominence', Number(e.target.value))}
                        onPointerUp={() => sendGhost(kind, 'prominence')} onKeyUp={() => sendGhost(kind, 'prominence')}
                        onBlur={() => sendGhost(kind, 'prominence')} />
                      {' '}<b>{prominence}%</b>
                    </td>
                    <td style={CELL}>
                      <button className="tag tag-btn" onClick={() => cmd('GHOST', { kind })}>test now</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="dim">Not in the telemetry yet (an older server).</p>
        )}
      </section>

      <CenitSection c={t.cenit} settings={settings} cmd={cmd} />

      <section className="card">
        <h3>Displays</h3>
        <p className="dim">
          Every page drawing a view. "Showing" means it reports in, is on screen and is drawing
          frames; the computer pages say whether the monitor itself is on.
        </p>
        {displays.length === 0 ? (
          <p className="dim">No display is connected.</p>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['display', 'view', '', 'fps', 'errors', ''].map((h, i) => <th key={i} style={CELL}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {displays.map((d) => (
                <tr key={d.id}>
                  <td style={CELL}>{d.id}{d.audio ? ' ♪' : ''}</td>
                  <td style={CELL}>{d.view}</td>
                  <td style={CELL}><Showing on={d.showing} /></td>
                  <td style={CELL}>{d.fps ?? '-'}</td>
                  <td style={{ ...CELL, color: d.errors ? '#f87171' : undefined }} title={d.last_error || ''}>
                    {d.errors || ''}
                  </td>
                  <td style={CELL}>
                    <button className="tag tag-btn" onClick={() => cmd('IDENTIFY', { ids: [d.id] })}>identify</button>{' '}
                    <button className="tag tag-btn" onClick={() => cmd('RELOAD', { ids: [d.id] })}>reload</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
