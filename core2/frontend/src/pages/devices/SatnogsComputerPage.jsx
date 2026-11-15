import { useState } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// computer.satnogs — one display computer of the SatNOGS installation (Linux Mint, running
// C12/SatNOGS poc/agent/agent.py). It opens a full-screen browser per screen and reports, per
// screen: plugged in, awake or blanked, browser running, and whether the page is actually drawing
// (the installation server hears from every display).
//
//   SCREEN   {"on": false} blanks the screens, {"on": true} wakes them
//   BROWSER  {"action": "restart" | "stop" | "start"}
//   POWER    {"action": "reboot"} / {"action": "poweroff", "wake": "09:00"} — turns itself back
//            on at that time with the BIOS clock alarm
//   IDENTIFY / RELOAD  this computer's displays only

const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 2px', alignItems: 'center' };
const TABLE = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const CELL = { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #333' };
const GOOD = '#34d399';
const BAD = '#f87171';

function Flag({ value, yes = 'yes', no = 'no' }) {
  if (value == null) return <span className="dim">?</span>;
  return <span style={{ color: value ? GOOD : BAD }}>{value ? yes : no}</span>;
}

function duration(seconds) {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export default function SatnogsComputerPage({ node, sendCommand, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const meta = node.meta || {};
  const t = node.telemetry || {};
  const screens = t.screens || [];
  const cmd = (cap, params = {}) => sendCommand(node.device_id, cap, params);
  // the wake-up time typed here, else its daily schedule's, else 9:00
  const [wakeTyped, setWake] = useState(null);
  const wake = wakeTyped ?? (meta.schedule && meta.schedule.on) ?? '09:00';

  const confirmPower = (action, wakeAt) => {
    const what = action === 'reboot' ? 'Reboot' : wakeAt ? `Power off until ${wakeAt}` : 'Power off (it stays off)';
    if (window.confirm(`${what}: ${t.host || node.device_id}?`)) {
      cmd('POWER', wakeAt ? { action, wake: wakeAt } : { action });
    }
  };

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>{t.host || 'SatNOGS computer'} <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="meta-row">
        <span>Zone: <b>{node.zone || '-'}</b></span>
        <span>IP: <b>{t.ip || '-'}</b></span>
        <span>Up: <b>{duration(t.uptime)}</b></span>
        <span>Installation server: <Flag value={t.server} yes="reachable" no="unreachable" /></span>
        <span>Schedule: <b>{t.schedule || 'none'}</b></span>
      </div>

      <div className="meta-row">
        <span>CPU: <b>{t.cpu ?? '-'}%</b></span>
        <span>Memory: <b>{t.memory ?? '-'}%</b></span>
        <span>Temperature: <b>{t.temperature ?? '-'} °C</b></span>
        <span>Disk:{' '}
          {t.disk == null
            ? <span className="dim">unknown</span>
            : <b style={{ color: t.disk === 'ok' ? GOOD : BAD }}>{t.disk}</b>}
        </span>
      </div>

      <section className="card">
        <h3>Screens: {t.screens_showing ?? '-'} of {t.screens_total ?? '-'} showing</h3>
        {screens.length === 0 ? (
          <p className="dim">No screens configured in its agent.ini.</p>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['output', 'view', 'plugged in', 'picture', 'power', 'browser', 'page', 'showing', 'fps'].map((h) => (
                  <th key={h} style={CELL}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.output}>
                  <td style={CELL}>{s.output}</td>
                  <td style={CELL}>{s.view}</td>
                  <td style={CELL}><Flag value={s.connected} /></td>
                  <td style={CELL} title="the computer is sending it a picture"><Flag value={s.active} /></td>
                  <td style={CELL}>{s.power ?? '?'}</td>
                  <td style={CELL}><Flag value={s.browser} yes="running" no="closed" /></td>
                  <td style={CELL} title="its page is connected to the installation server">
                    <Flag value={s.page} yes="connected" no="not connected" />
                  </td>
                  <td style={CELL}><Flag value={s.showing} /></td>
                  <td style={CELL}>{s.fps ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="dim">
          Whether a monitor is switched off with its own button can't be read from here (only that
          it's plugged in and receiving a picture).
        </p>
        <div style={ROW}>
          <button className="jog-btn" onClick={() => cmd('SCREEN', { on: true })}>Screens on</button>
          <button className="jog-btn" onClick={() => cmd('SCREEN', { on: false })}>Screens off</button>
          <button className="jog-btn" onClick={() => cmd('IDENTIFY')}>Identify</button>
          <button className="jog-btn" onClick={() => cmd('RELOAD')}>Reload pages</button>
        </div>
        <div style={ROW}>
          <button className="jog-btn" onClick={() => cmd('BROWSER', { action: 'restart' })}>Restart browsers</button>
          <button className="jog-btn" onClick={() => cmd('BROWSER', { action: 'stop' })}>Close browsers</button>
          <button className="jog-btn" onClick={() => cmd('BROWSER', { action: 'start' })}>Open browsers</button>
          {t.browsers === false && <span className="dim">browsers closed on purpose</span>}
        </div>
      </section>

      <section className="card">
        <h3>Power</h3>
        <p className="dim">
          Powering off with a wake-up time sets the computer's own clock alarm, so it turns back on by
          itself (it needs the BIOS to allow it, and stays off if it doesn't).
        </p>
        <div style={ROW}>
          <label htmlFor={`wake-${node.device_id}`}>Wake up at</label>
          <input id={`wake-${node.device_id}`} type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
          <button className="jog-btn" onClick={() => confirmPower('poweroff', wake)}>Power off until then</button>
        </div>
        <div style={ROW}>
          <button className="jog-btn" onClick={() => confirmPower('reboot')}>Reboot</button>
          <button className="halt-btn" onClick={() => confirmPower('poweroff')}>Power off</button>
        </div>
      </section>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes || []} onCommand={sendCommand} />
    </div>
  );
}
