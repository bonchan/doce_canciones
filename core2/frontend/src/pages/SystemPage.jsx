import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../api';
import './SystemPage.css';

// ── formatting ────────────────────────────────────────────────────────────
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const percent = (share) => `${Math.round(share * 100)}%`;
const longDate = (secs) =>
  new Date(secs * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function duration(secs) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
const ago = (secs, now) => `${duration(Math.max(0, now - secs))} ago`;

/** Calls `fn` now and then every `ms` (which may change, e.g. faster while an update runs). */
function usePoll(fn, ms) {
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; });
  useEffect(() => {
    saved.current();
    const timer = setInterval(() => saved.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** The current time in seconds, ticking every few seconds, for "for 3h" / "5m ago". */
function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// ── the page ──────────────────────────────────────────────────────────────
// The NUC itself: is everything running, how to reach it, the watchdog, updates, restart / reboot.
export default function SystemPage({ apiKey, setApiKey }) {
  const [system, setSystem] = useState(null);
  const [down, setDown] = useState(false);

  usePoll(() => {
    request('GET', '/api/system')
      .then((s) => { setSystem(s); setDown(false); })
      .catch(() => setDown(true));
  }, 5000);

  return (
    <div className="app system-page">
      {down && <div className="error-banner">The backend isn't answering (restarting?). Retrying every few seconds…</div>}

      <header className="header">
        <div>
          <h2>System</h2>
          <p className="hint">The NUC the installation's brain runs on.</p>
        </div>
        <div className="api-key">
          <label htmlFor="sys-key">X-API-Key</label>
          <input id="sys-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="needed for Update, restart, reboot" />
        </div>
      </header>

      <div className="sys-grid">
        <Overview system={system} />
        <Installation system={system} />
        <Services system={system} apiKey={apiKey} />
        <Network system={system} />
        <Watchdog system={system} />
      </div>
      <Updates apiKey={apiKey} />
      <DangerZone apiKey={apiKey} />
    </div>
  );
}

function Section({ title, children, className = '', id }) {
  return (
    <section className={`sys-section ${className}`} id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** One row; "…" until the first answer, left out when the backend couldn't read it (not on Linux). */
function Fact({ label, system, value }) {
  if (system && (value === null || value === undefined || value === false)) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{system ? value : '…'}</dd>
    </>
  );
}

function Overview({ system }) {
  const now = useNow();
  const s = system || {};
  const temp = s.temperature ?? null, cpu = s.cpu ?? null, mem = s.memory ?? null, up = s.uptime ?? null;
  return (
    <Section title="NUC">
      <dl className="facts">
        <Fact label="Host" system={system} value={s.hostname} />
        <Fact label="Code" system={system} value={s.version && <>
          <code>{s.version.short}</code> {s.version.subject} <span className="hint">{longDate(s.version.time)}</span>
        </>} />
        <Fact label="Up for" system={system} value={up !== null && <>
          {duration(up)} <span className="hint">· since {longDate(now - up)}</span>
        </>} />
        <Fact label="Clock" system={system} value={s.clock_synced !== null && s.clock_synced !== undefined && (
          <span className={s.clock_synced ? 'ok' : 'bad'}>{s.clock_synced ? 'synced with the internet' : 'NOT synced'}</span>
        )} />
        <Fact label="Temperature" system={system} value={temp !== null && (
          <span className={temp >= 85 ? 'bad' : temp >= 75 ? 'caution' : ''}>{temp.toFixed(1)} °C</span>
        )} />
        <Fact label="CPU" system={system} value={cpu && <>
          <span className={cpu.usage >= 0.9 ? 'caution' : ''}>{percent(cpu.usage)}</span>
          <span className="hint"> · {cpu.cores} cores</span>
        </>} />
        <Fact label="Memory" system={system} value={mem &&
          `${gb(mem.used)} of ${gb(mem.total)} (${percent(mem.used / mem.total)})`} />
        <Fact label="Disk" system={system} value={s.disk && (
          <span className={s.disk.free < 2e9 ? 'bad' : ''}>
            {gb(s.disk.used)} used, {gb(s.disk.free)} free of {gb(s.disk.total)}
          </span>
        )} />
        <Fact label="Data folder" system={system} value={s.data_dir && <code>{s.data_dir}</code>} />
      </dl>
    </Section>
  );
}

function Installation({ system }) {
  const s = system || {};
  return (
    <Section title="Installation">
      <dl className="facts">
        <Fact label="MQTT" system={system} value={s.mqtt && <>
          <span className={s.mqtt.connected ? 'ok' : 'bad'}>{s.mqtt.connected ? 'connected' : 'not connected'}</span>
          <span className="hint"> · {s.mqtt.broker}</span>
        </>} />
        <Fact label="File server" system={system} value={s.file_server && <>
          <span className={s.file_server.ok ? 'ok' : 'bad'}>{s.file_server.ok ? 'answering' : 'not answering'}</span>
          <span className="hint"> · {s.file_server.url}</span>
        </>} />
        <Fact label="Devices" system={system} value={s.devices && <>
          <span className={s.devices.online < s.devices.total ? 'caution' : 'ok'}>{s.devices.online} online</span>
          {' '}of {s.devices.total}
        </>} />
      </dl>
    </Section>
  );
}

const RESTARTS = { 'doce-brain': 'restart-app', 'doce-files': 'restart-files', mosquitto: 'restart-mqtt' };

function Services({ system, apiKey }) {
  const now = useNow();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({ text: '', bad: false });
  const list = system?.services;

  async function restart(service) {
    if (!window.confirm(`Restart ${service.label}?`)) return;
    setBusy(service.unit); setMsg({ text: '', bad: false });
    try {
      await request('POST', `/api/system/${RESTARTS[service.unit]}`, { apiKey });
      setMsg({ text: `${service.label}: restarting…`, bad: false });
    } catch (e) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy('');
    }
  }

  return (
    <Section title="Services" className="wide">
      {system && !list && <p className="hint">systemd isn't available here (not running on the NUC).</p>}
      {!system && <p className="hint">…</p>}
      {list && (
        <table className="services">
          <tbody>
            {list.map((svc) => {
              const ok = svc.active === 'active';
              return (
                <tr key={svc.unit}>
                  <td><span className={`dot ${ok ? 'dot-ok' : 'dot-bad'}`} /></td>
                  <td><b>{svc.label}</b><div className="hint"><code>{svc.unit}</code></div></td>
                  <td>
                    {!svc.installed ? <span className="bad">not installed</span>
                      : <span className={ok ? 'ok' : 'bad'}>{svc.active}{svc.sub && svc.sub !== svc.active ? ` (${svc.sub})` : ''}</span>}
                    {ok && svc.since && <div className="hint">for {duration(now - svc.since)}</div>}
                  </td>
                  <td>
                    {svc.restarts ? (
                      <span className="caution" title="Times systemd restarted it after it stopped by itself, since it was last started by hand">
                        restarted by systemd {svc.restarts}×
                      </span>
                    ) : null}
                  </td>
                  <td className="right">
                    {RESTARTS[svc.unit] && svc.installed && (
                      <button disabled={!!busy || !apiKey} onClick={() => restart(svc)}>Restart</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {msg.text && <p className={msg.bad ? 'bad' : 'ok'}>{msg.text}</p>}
    </Section>
  );
}

/** How other computers reach the NUC: by name, and every IPv4 / IPv6 address it has. */
function Network({ system }) {
  const s = system || {};
  const port = window.location.port || '8000';
  const links = [];
  if (s.hostname) links.push(`http://${s.hostname}.local:${port}`);
  (s.network || []).forEach((iface) =>
    iface.addresses.forEach((a) => {
      if (a.scope === 'link') return;          // fe80:: addresses: browsers can't open them
      links.push(a.family === 'ipv6' ? `http://[${a.address}]:${port}` : `http://${a.address}:${port}`);
    })
  );
  return (
    <Section title="Network">
      {!system && <p className="hint">…</p>}
      {system && s.network && (
        <>
          <p className="hint">Open the webapp from another computer at:</p>
          <ul className="links">
            {links.map((l) => <li key={l}><a href={l}>{l}</a></li>)}
          </ul>
          <dl className="facts">
            {s.network.map((iface) => (
              <React.Fragment key={iface.name}>
                <dt>{iface.name}</dt>
                <dd>
                  {iface.addresses.map((a) => (
                    <div key={a.address}>
                      <code>{a.address}</code> <span className="hint">{a.family}{a.scope === 'link' ? ', link-local' : ''}</span>
                    </div>
                  ))}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </>
      )}
      {system && !s.network && <p className="hint">Network details are only available on Linux.</p>}
    </Section>
  );
}

function Watchdog({ system }) {
  const now = useNow();
  const w = system?.watchdog;
  const stale = w?.checked_at && now - w.checked_at > 180;
  return (
    <Section title="Watchdog" className="wide">
      <p className="hint">
        Every minute it checks that the backend, the file server and MQTT answer, and restarts whatever
        stopped answering (twice in a row) or stopped.
      </p>
      {!system && <p className="hint">…</p>}
      {w && !w.checked_at && <p className="caution">No check yet — is doce-watchdog.timer installed? (scripts/install.sh)</p>}
      {w?.checked_at && (
        <dl className="facts">
          <dt>Last check</dt>
          <dd>
            <span className={stale ? 'bad' : ''}>{ago(w.checked_at, now)}</span>
            {stale && <span className="bad"> · the watchdog isn't running</span>}
          </dd>
          <dt>Result</dt><dd>{w.state}</dd>
        </dl>
      )}
      {w && (
        <details className="log-details">
          <summary>Restarts it made ({w.log.length})</summary>
          {w.log.length ? <pre className="console">{w.log.join('\n')}</pre> : <p className="hint">None yet.</p>}
        </details>
      )}
    </Section>
  );
}

// ── updates ───────────────────────────────────────────────────────────────
function Updates({ apiKey }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);           // 'check' | 'apply'
  const [actionError, setActionError] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [firstSeen, setFirstSeen] = useState(null);  // the version this page was loaded with

  const show = useCallback((d) => {
    setData(d);
    setFirstSeen((f) => f ?? d.current?.hash ?? null);
  }, []);
  const load = useCallback(() => {
    request('GET', '/api/update').then(show).catch(() => {});   // the backend restarts during an update
  }, [show]);
  const running = !!data?.running || busy === 'apply';
  usePoll(load, running ? 2000 : 20000);
  const open = logOpen || !!data?.running;            // the log opens by itself while an update runs

  async function run(action) {
    setBusy(action); setActionError('');
    if (action === 'apply') setLogOpen(true);
    try {
      show(await request('POST', action === 'check' ? '/api/update/check' : '/api/update/apply', { apiKey }));
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return <Section title="Updates" id="updates"><p className="hint">…</p></Section>;
  }

  const behind = data.behind ?? 0;
  const commits = data.commits ?? [];
  const dirty = data.dirty ?? [];
  const forApp = (data.app_changes ?? 0) > 0;
  const appPaths = (data.app_paths ?? []).join(', ');
  const updated = data.current && firstSeen && data.current.hash !== firstSeen;
  const blocked = data.running || dirty.length > 0 || (data.ahead ?? 0) > 0 || behind === 0;

  return (
    <Section title="Updates" id="updates" className="updates">
      {data.error && <p className="bad">{data.error}</p>}
      {updated && data.last_run?.pull_only && <p className="ok">Pulled to {data.current.short} (nothing to rebuild).</p>}
      {updated && !data.last_run?.pull_only && (
        <p className="ok">
          Updated to <code>{data.current.short}</code>.{' '}
          <button className="primary" onClick={() => window.location.reload()}>Reload the page</button>
        </p>
      )}
      <dl className="facts">
        {data.current && <>
          <dt>Running</dt>
          <dd><code>{data.current.short}</code> {data.current.subject} <span className="hint">{longDate(data.current.time)}</span></dd>
        </>}
        {data.branch && <><dt>Branch</dt><dd>{data.branch}{data.upstream && ` ← ${data.upstream}`}</dd></>}
        <dt>Checked GitHub</dt><dd>{data.checked_at ? longDate(data.checked_at) : 'not yet'}</dd>
      </dl>
      <div className="row">
        <button disabled={busy !== null} onClick={() => run('check')}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {!data.upstream && !data.error && <p className="hint">This branch doesn't follow one on GitHub, so there's nothing to compare with.</p>}
      {data.upstream && behind === 0 && <p className="ok">Up to date.</p>}
      {behind > 0 && (
        <>
          <h4>{behind === 1 ? '1 new commit' : `${behind} new commits`} on {data.upstream}</h4>
          {data.diffstat && <p className="hint">{data.diffstat}</p>}
          <ul className="commits">
            {commits.map((c) => <Commit key={c.hash} commit={c} />)}
          </ul>
        </>
      )}
      {dirty.length > 0 && (
        <div className="warning">
          <p>Files were changed by hand on the NUC, so it can't update itself. Commit or undo them first:</p>
          <ul className="files">{dirty.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
        </div>
      )}
      {(data.ahead ?? 0) > 0 && <p className="warning">The NUC has {data.ahead} commit(s) that aren't on GitHub; update it by hand.</p>}
      {behind > 0 && (
        <>
          <p className="hint">
            {forApp
              ? 'Update pulls these commits, reinstalls dependencies, rebuilds the webapp and restarts the backend and file server (the page is away for a minute).'
              : `None of these commits change what the NUC runs (${appPaths}); Update just pulls them, nothing restarts.`}
          </p>
          {!apiKey && <p className="caution">Enter the X-API-Key above to update.</p>}
          <button className={forApp ? 'primary' : ''} disabled={blocked || busy !== null || !apiKey}
            onClick={() => {
              const short = commits[0]?.short ?? '';
              if (window.confirm(forApp ? `Update to ${short} and restart?` : `Pull to ${short}?`)) run('apply');
            }}>
            {data.running ? 'Updating…' : forApp ? 'Update now' : 'Pull'}
          </button>
        </>
      )}
      {actionError && <p className="bad">{actionError}</p>}

      {(data.running || data.last_run) && (
        <details className="log-details" open={open} onToggle={(e) => setLogOpen(e.currentTarget.open)}>
          <summary>
            Update log
            {data.running && <span className="hint"> · running</span>}
            {!data.running && data.last_run?.result === 'ok' && <span className="ok"> · finished</span>}
            {!data.running && data.last_run?.result === 'failed' && <span className="bad"> · failed</span>}
          </summary>
          {data.last_run && <UpdateLog lines={data.last_run.log} open={open} />}
        </details>
      )}
    </Section>
  );
}

/** Follows new lines like a terminal, scrolling only its own box. */
function UpdateLog({ lines, open }) {
  const ref = useRef(null);
  const text = lines.join('\n');
  useEffect(() => {
    if (ref.current && open) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, open]);
  return <pre ref={ref} className="console">{text}</pre>;
}

function Commit({ commit }) {
  return (
    <li className={commit.affects_app ? '' : 'not-app'}>
      <div><b>{commit.subject}</b></div>
      <div className="hint">
        <code>{commit.short}</code> · {commit.author} · {longDate(commit.time)}
        {!commit.affects_app && ' · not for the NUC'}
      </div>
      {commit.body && <pre className="commit-body">{commit.body}</pre>}
      {commit.files.length > 0 && (
        <details>
          <summary>{commit.files.length} file{commit.files.length === 1 ? '' : 's'}</summary>
          <ul className="files">
            {commit.files.map((f) => (
              <li key={f.path}><span className={`fstat s-${f.status}`}>{f.status}</span> {f.path}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

// ── reboot / power off ────────────────────────────────────────────────────
const POWER = [
  { action: 'reboot', title: 'Reboot the NUC', hint: 'Everything comes back by itself in a minute or two.',
    button: 'Reboot', confirm: 'Reboot the NUC now?', done: 'Rebooting… this page reconnects when it is back.' },
  { action: 'poweroff', title: 'Power off the NUC', hint: 'It stays off until someone presses its power button.',
    button: 'Power off', confirm: 'Power off the NUC? Someone has to press its power button to start it again.',
    done: 'Powering off.' },
];

function DangerZone({ apiKey }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  async function run(p) {
    if (!window.confirm(p.confirm)) return;
    setBusy(true); setError(''); setDone('');
    try {
      await request('POST', `/api/system/${p.action}`, { apiKey });
      setDone(p.done);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Danger zone" className="danger-zone">
      {POWER.map((p) => (
        <div key={p.action} className="danger-row">
          <div>
            <b>{p.title}</b>
            <p className="hint">{p.hint}</p>
          </div>
          <button className="danger" disabled={busy || done !== '' || !apiKey} onClick={() => run(p)}>{p.button}</button>
        </div>
      ))}
      {done && <p className="ok">{done}</p>}
      {error && <p className="bad">{error}</p>}
    </Section>
  );
}
