import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type ConnectionView, type LogEntry } from './api';
import { CollectCard, TestCard } from './ServiceNowView';

const profile = 'basic' as const;

/**
 * Admins: a ServiceNow connection with a user name and password, for demos and developer instances. Kept apart
 * from the OAuth connection; every request and step is logged at the bottom for troubleshooting.
 */
export function DemoConnectionView({ onBlueprint }: { onBlueprint: (id: string) => Promise<void> }) {
  const [view, setView] = useState<ConnectionView>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const [v, l] = await Promise.all([call<ConnectionView>('connection', { profile }), call<{ entries: LogEntry[] }>('snLogs', { profile })]);
      setView(v); setLogs(l.entries);
      if (v.jobs.some((j) => j.status === 'queued' || j.status === 'running')) timer.current = setTimeout(() => void load(), 4000);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); return () => clearTimeout(timer.current); }, [load]);

  if (!view) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <div>
      <div className="notice">
        Demo connection: basic authentication with a ServiceNow user name and password, for demos and developer instances.
        Use the OAuth connection for customer instances.
      </div>
      {error && <div className="error">{error}</div>}
      <BasicForm view={view} onSaved={async (v) => { setView(v); setError(undefined); await load(); }} />
      {view.connection && <TestCard view={view} onTested={load} profile={profile} />}
      {view.connection && <CollectCard view={view} onChanged={load} onBlueprint={onBlueprint} profile={profile} />}
      <LogPanel entries={logs} onRefresh={load} onClear={async () => { setLogs((await call<{ entries: LogEntry[] }>('clearSnLogs', { profile })).entries); }} />
    </div>
  );
}

function BasicForm({ view, onSaved }: { view: ConnectionView; onSaved: (v: ConnectionView) => Promise<void> }) {
  const c = view.connection;
  const [f, setF] = useState({
    instance: c?.instance ?? '', username: c?.username ?? '', password: '', customer: c?.customer ?? '',
    usageDays: String(c?.usageDays ?? 365), requestsPerSecond: String(c?.requestsPerSecond ?? 4),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const run = async (fn: () => Promise<ConnectionView>) => {
    setBusy(true); setError(undefined); setSaved(false);
    try { const v = await fn(); await onSaved(v); setF((x) => ({ ...x, password: '' })); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h3>ServiceNow demo connection (basic auth)</h3>
      <p className="muted">
        Read-only, like the OAuth connection. The user needs read access to the configuration tables (admin works on a developer instance).
        Only *.service-now.com and *.servicenowservices.com instances.
      </p>
      <table className="grid"><tbody>
        <tr><th>Instance</th><td><input className="input wide" value={f.instance} onChange={set('instance')} placeholder="https://dev12345.service-now.com" /></td></tr>
        <tr><th>User name</th><td><input className="input wide" value={f.username} onChange={set('username')} autoComplete="off" /></td></tr>
        <tr><th>Password</th><td><input className="input wide" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" placeholder={view.hasPassword ? 'stored (leave blank to keep)' : ''} /></td></tr>
        <tr><th>Customer</th><td><input className="input wide" value={f.customer} onChange={set('customer')} placeholder="Name shown on the blueprint (defaults to the instance name)" /></td></tr>
        <tr><th>Usage window</th><td><input className="input" type="number" min={1} max={1095} value={f.usageDays} onChange={set('usageDays')} /> days of ticket volume</td></tr>
        <tr><th>Rate limit</th><td><input className="input" type="number" min={0.5} max={10} step={0.5} value={f.requestsPerSecond} onChange={set('requestsPerSecond')} /> requests per second</td></tr>
      </tbody></table>
      <p className="muted">The password goes to encrypted app storage and is never shown again. Changing the instance or user requires entering it again.</p>
      <div className="row end">
        {c && <button className="btn danger" disabled={busy} onClick={() => void run(() => call<ConnectionView>('removeConnection', { profile }))}>Remove connection</button>}
        <button className="btn primary" disabled={busy} onClick={() => void run(() => call<ConnectionView>('saveConnection', {
          profile, instance: f.instance, username: f.username.trim(),
          usageDays: Number(f.usageDays) || 365, requestsPerSecond: Number(f.requestsPerSecond) || 4,
          ...(f.password ? { password: f.password } : {}), ...(f.customer.trim() ? { customer: f.customer.trim() } : {}),
        }))}>Save</button>
      </div>
      {saved && <div className="notice">Saved.</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function LogPanel({ entries, onRefresh, onClear }: { entries: LogEntry[]; onRefresh: () => Promise<void>; onClear: () => Promise<void> }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const failed = (e: LogEntry) => (e.kind === 'event' ? e.level === 'error' : Boolean(e.error) || (e.status !== undefined && (e.status < 200 || e.status >= 300)));
  const shown = errorsOnly ? entries.filter(failed) : entries;
  return (
    <div className="card">
      <h3>Logs</h3>
      <p className="muted">The last 250 ServiceNow requests and workbench events for this connection, newest first. Credentials and tokens are never recorded.</p>
      <div className="row">
        <button className="btn" onClick={() => void onRefresh()}>Refresh</button>
        <button className="btn" onClick={() => void onClear()} disabled={!entries.length}>Clear</button>
        <label className="row"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors only</label>
        <span className="muted">{entries.length} entries</span>
      </div>
      {shown.length === 0 ? <p className="muted">Nothing logged yet: save, test or collect.</p> : (
        <table className="grid log">
          <thead><tr><th>Time</th><th>What</th><th>Status</th><th>ms</th><th>Detail</th></tr></thead>
          <tbody>
            {shown.map((e, n) => e.kind === 'event' ? (
              <tr key={n} className={e.level === 'error' ? 'log-error' : ''}>
                <td className="muted">{new Date(e.at).toLocaleTimeString()}</td>
                <td colSpan={4}>{e.message}</td>
              </tr>
            ) : (
              <tr key={n} className={failed(e) ? 'log-error' : ''}>
                <td className="muted">{new Date(e.at).toLocaleTimeString()}</td>
                <td><code>{e.method} {e.path}</code></td>
                <td>{e.status ?? 'no response'}</td>
                <td>{e.ms}</td>
                <td>{e.error ?? e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
