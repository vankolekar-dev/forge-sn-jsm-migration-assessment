import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type ConnectionView, type Job } from './api';

const PHASES: Record<string, string> = { info: 'instance version', pulls: 'tables', aggregates: 'counts', fill: 'CMDB fill rates', done: 'analysis' };

/** Admins: connect to ServiceNow over OAuth and collect + analyse into a blueprint, instead of uploading one. */
export function ServiceNowView({ onBlueprint }: { onBlueprint: (id: string) => Promise<void> }) {
  const [view, setView] = useState<ConnectionView>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const v = await call<ConnectionView>('connection');
      setView(v);
      if (v.jobs.some((j) => j.status === 'queued' || j.status === 'running')) timer.current = setTimeout(() => void load(), 4000);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); return () => clearTimeout(timer.current); }, [load]);

  if (!view) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <div>
      {error && <div className="error">{error}</div>}
      <ConnectionForm view={view} onSaved={(v) => { setView(v); setError(undefined); }} />
      {view.connection && <TestCard view={view} onTested={load} />}
      {view.connection && <CollectCard view={view} onChanged={load} onBlueprint={onBlueprint} />}
    </div>
  );
}

function ConnectionForm({ view, onSaved }: { view: ConnectionView; onSaved: (v: ConnectionView) => void }) {
  const c = view.connection;
  const [f, setF] = useState({
    instance: c?.instance ?? '', grant: c?.grant ?? 'client_credentials', clientId: c?.clientId ?? '', clientSecret: '',
    username: c?.username ?? '', password: '', customer: c?.customer ?? '', usageDays: String(c?.usageDays ?? 365), requestsPerSecond: String(c?.requestsPerSecond ?? 4),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const run = async (fn: () => Promise<ConnectionView>) => {
    setBusy(true); setError(undefined); setSaved(false);
    try { const v = await fn(); onSaved(v); setF((x) => ({ ...x, clientSecret: '', password: '' })); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const password = f.grant === 'password';
  return (
    <div className="card">
      <h3>ServiceNow connection</h3>
      <p className="muted">
        Read-only: the workbench reads configuration, catalog, workflow and CMDB metadata through the Table and Aggregate APIs, plus usage counts.
        It does not read CI records or change anything in ServiceNow. Only *.service-now.com and *.servicenowservices.com instances.
      </p>
      <table className="grid"><tbody>
        <tr><th>Instance</th><td><input className="input wide" value={f.instance} onChange={set('instance')} placeholder="https://acme.service-now.com" /></td></tr>
        <tr><th>OAuth grant</th><td>
          <label className="row"><input type="radio" checked={!password} onChange={() => setF({ ...f, grant: 'client_credentials' })} /> client credentials (the OAuth application user's roles apply)</label>
          <label className="row"><input type="radio" checked={password} onChange={() => setF({ ...f, grant: 'password' })} /> password, as a read-only integration user</label>
        </td></tr>
        <tr><th>Client id</th><td><input className="input wide" value={f.clientId} onChange={set('clientId')} autoComplete="off" /></td></tr>
        <tr><th>Client secret</th><td><input className="input wide" type="password" value={f.clientSecret} onChange={set('clientSecret')} autoComplete="new-password" placeholder={view.hasClientSecret ? 'stored (leave blank to keep)' : ''} /></td></tr>
        {password && <tr><th>Integration user</th><td><input className="input wide" value={f.username} onChange={set('username')} autoComplete="off" /></td></tr>}
        {password && <tr><th>Password</th><td><input className="input wide" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" placeholder={view.hasPassword ? 'stored (leave blank to keep)' : ''} /></td></tr>}
        <tr><th>Customer</th><td><input className="input wide" value={f.customer} onChange={set('customer')} placeholder="Name shown on the blueprint" /></td></tr>
        <tr><th>Usage window</th><td><input className="input" type="number" min={1} max={1095} value={f.usageDays} onChange={set('usageDays')} /> days of ticket volume</td></tr>
        <tr><th>Rate limit</th><td><input className="input" type="number" min={0.5} max={10} step={0.5} value={f.requestsPerSecond} onChange={set('requestsPerSecond')} /> requests per second</td></tr>
      </tbody></table>
      <p className="muted">Secrets go to encrypted app storage and are never shown again. Changing the instance, client id or user requires entering them again.</p>
      <div className="row end">
        {c && <button className="btn danger" disabled={busy} onClick={() => void run(() => call<ConnectionView>('removeConnection'))}>Remove connection</button>}
        <button className="btn primary" disabled={busy} onClick={() => void run(() => call<ConnectionView>('saveConnection', {
          instance: f.instance, grant: f.grant, clientId: f.clientId.trim(), customer: f.customer,
          usageDays: Number(f.usageDays) || 365, requestsPerSecond: Number(f.requestsPerSecond) || 4,
          ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}),
          ...(password ? { username: f.username.trim(), ...(f.password ? { password: f.password } : {}) } : {}),
        }))}>Save</button>
      </div>
      {saved && <div className="notice">Saved.</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function TestCard({ view, onTested }: { view: ConnectionView; onTested: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = view.connection!.lastTest;
  return (
    <div className="card">
      <h3>Test the connection</h3>
      <div className="row">
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true); setError(undefined);
          try { await call('testConnection'); await onTested(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? 'Testing…' : 'Test connection'}</button>
        {t && <span className={t.ok ? 'lozenge ok' : 'lozenge bad'}>{t.ok ? 'working' : 'failing'}</span>}
        {t && <span className="muted">{t.release ? `${t.release} · ` : ''}tested {new Date(t.at).toLocaleString()}</span>}
      </div>
      {t && (
        <table className="grid"><tbody>
          {t.checks.map((x) => <tr key={x.name}><td>{x.ok ? '✓' : '✗'}</td><th>{x.name}</th><td>{x.detail}</td></tr>)}
        </tbody></table>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function CollectCard({ view, onChanged, onBlueprint }: { view: ConnectionView; onChanged: () => Promise<void>; onBlueprint: (id: string) => Promise<void> }) {
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = view.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const act = async (name: string, payload: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try { await call(name, payload); await onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h3>Collect and analyse</h3>
      <p>
        Reads the instance in steps of up to ten minutes, checkpointing as it goes, then analyses it into blueprint <code>{view.nextBlueprintId}</code>.
        Large instances take several steps; a failed collection resumes from its last checkpoint. The blueprint still needs sign-off before anything is built.
      </p>
      <div className="row">
        <button className="btn primary" disabled={busy || Boolean(active)} onClick={() => void act('startCollection', { replace })}>Collect &amp; analyse</button>
        <label className="row"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> replace a blueprint with the same id (its sign-off must be renewed)</label>
      </div>
      {error && <div className="error">{error}</div>}
      {view.jobs.length > 0 && <h4>Collections</h4>}
      {view.jobs.map((j) => <CollectJob key={j.id} job={j} busy={busy} onResume={() => void act('resumeCollection', { jobId: j.id })} onOpen={onBlueprint} />)}
    </div>
  );
}

function CollectJob({ job, busy, onResume, onOpen }: { job: Job; busy: boolean; onResume: () => void; onOpen: (id: string) => Promise<void> }) {
  const p = job.progress;
  const r = job.result as { blueprintId: string; records: number; release: string | null; warningCount: number; warnings: string[]; outcomes: number; replaced: boolean } | undefined;
  const lozenge = job.status === 'done' ? 'lozenge ok' : job.status === 'failed' ? 'lozenge bad' : 'lozenge warn';
  return (
    <div className="card">
      <div className="row">
        <span className={lozenge}>{job.status}</span>
        <span className="muted">started {new Date(job.queuedAt).toLocaleString()}{job.step ? ` · step ${job.step + 1}` : ''}</span>
      </div>
      {p && job.status !== 'done' && (
        <div>
          <div className="muted">Reading {PHASES[p.phase] ?? p.phase}{p.total ? `: ${Math.min(p.index + 1, p.total)} of ${p.total}` : ''} · {p.pages} pages{p.warnings ? ` · ${p.warnings} warnings` : ''}</div>
          {p.total > 0 && <progress max={p.total} value={p.index} />}
        </div>
      )}
      {job.status === 'failed' && (
        <div>
          <div className="error">{job.error}</div>
          <button className="btn" disabled={busy} onClick={onResume}>Resume from checkpoint</button>
        </div>
      )}
      {r && (
        <div>
          <p>{r.replaced ? 'Replaced' : 'Created'} blueprint <code>{r.blueprintId}</code> from {r.records} records{r.release ? ` (${r.release})` : ''}: {r.outcomes} outcomes.</p>
          {r.warningCount > 0 && (
            <details><summary>{r.warningCount} warnings (tables not present or not readable)</summary><ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
          )}
          <button className="btn primary" onClick={() => void onOpen(r.blueprintId)}>Open blueprint</button>
        </div>
      )}
    </div>
  );
}
