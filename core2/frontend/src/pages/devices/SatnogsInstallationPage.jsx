import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// installation.satnogs — the SatNOGS installation's server (C12/SatNOGS poc/installationwebapp):
// one shared timeline of satellite passes that every display (globes, reception, schedule,
// telemetry, signal) draws from. Its displays and the computers they run on are in the same zone
// ("satnogs"), each computer as a computer.satnogs device with its own page.
//
//   SKIP / RESTART      the pass on air
//   RELOAD / IDENTIFY   every display, or {"ids": [...]} only some
//   SETTINGS            the operator page's settings, e.g. {"speed": 4}, {"language": "es"}
//   QUEUE               {"pass_id": 10842543}: that pass right after the one on air
//
// The language list comes from its announce (node.meta.languages), so adding a language file
// there makes a button appear here.

const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 2px' };
const ON = { outline: '2px solid currentColor', opacity: 1 };
const TABLE = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const CELL = { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #333' };
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64];

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

export default function SatnogsInstallationPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const t = node.telemetry || {};
  const languages = meta.languages || [];
  const displays = t.displays || [];
  const cmd = (cap, params = {}) => sendCommand(node.device_id, cap, params);
  const settings = (patch) => cmd('SETTINGS', patch);

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
      </section>

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
