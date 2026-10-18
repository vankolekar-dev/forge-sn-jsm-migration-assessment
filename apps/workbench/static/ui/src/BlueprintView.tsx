import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type Boot, type Job } from './api';
import { Markdown } from './Markdown';
import { PhraseDialog } from './PhraseDialog';

type Tab = 'overview' | 'signoff' | 'build' | 'steps' | 'acceptance';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['signoff', 'Sign-off'], ['build', 'Build'], ['steps', 'Guided steps'], ['acceptance', 'Acceptance']];

export function BlueprintView({ boot, blueprintId, onChanged }: { boot: Boot; blueprintId: string; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<{ summary: any; status: any; jobs: Job[] }>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setData(await call('summary', { blueprintId })); setError(undefined); } catch (e) { setError((e as Error).message); }
  }, [blueprintId]);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await Promise.all([load(), onChanged()]); };

  return (
    <div>
      <h2>{data?.summary.name ?? blueprintId}</h2>
      <nav className="tabs">{TABS.map(([t, label]) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>)}</nav>
      {error && <div className="error">{error}</div>}
      {data && tab === 'overview' && <Overview boot={boot} blueprintId={blueprintId} data={data} onChanged={changed} />}
      {tab === 'signoff' && <SignOff blueprintId={blueprintId} onChanged={changed} />}
      {data && tab === 'build' && <Build boot={boot} blueprintId={blueprintId} jobs={data.jobs} onChanged={load} />}
      {tab === 'steps' && <Steps boot={boot} blueprintId={blueprintId} />}
      {tab === 'acceptance' && <Acceptance blueprintId={blueprintId} />}
    </div>
  );
}

function Overview({ boot, blueprintId, data, onChanged }: { boot: Boot; blueprintId: string; data: { summary: any; status: any; jobs: Job[] }; onChanged: () => Promise<void> }) {
  const { summary: s, status: st } = data;
  const [space, setSpace] = useState<{ designId: string; mode: 'new' | 'existing'; key: string; name: string; reason: string }>();
  const [error, setError] = useState<string>();
  return (
    <div>
      <div className="card">
        <div className="row">
          <span className={s.signedOff ? 'lozenge ok' : 'lozenge'}>{s.signedOff ? 'signed off' : 'not signed off'}</span>
          <span className="muted">{s.customer} · {s.outcomes.length} outcomes · {s.design.total} design elements · built {s.built}</span>
        </div>
        <table className="grid"><tbody>
          {Object.entries(s.design.byStrategy as Record<string, number>).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
        </tbody></table>
      </div>
      <div className="card">
        <h3>Spaces</h3>
        <table className="grid"><thead><tr><th>Design</th><th>Name</th><th>Mode</th><th>Key</th><th /></tr></thead><tbody>
          {s.spaces.map((sp: any) => (
            <tr key={sp.designId}><td>{sp.designId}</td><td>{sp.name}</td><td>{sp.mode}</td><td>{sp.key ?? '—'}</td>
              <td>{boot.role === 'admin' && <button className="btn" onClick={() => setSpace({ designId: sp.designId, mode: sp.mode, key: sp.key ?? '', name: sp.name, reason: '' })}>Change…</button>}</td></tr>
          ))}
        </tbody></table>
        {space && (
          <div className="card">
            <div className="row">
              <label><input type="radio" checked={space.mode === 'new'} onChange={() => setSpace({ ...space, mode: 'new' })} /> new space</label>
              <label><input type="radio" checked={space.mode === 'existing'} onChange={() => setSpace({ ...space, mode: 'existing' })} /> existing space</label>
              <input className="input" placeholder="key" value={space.key} onChange={(e) => setSpace({ ...space, key: e.target.value.toUpperCase() })} />
              {space.mode === 'new' && <input className="input" placeholder="name" value={space.name} onChange={(e) => setSpace({ ...space, name: e.target.value })} />}
              <input className="input" placeholder="reason" value={space.reason} onChange={(e) => setSpace({ ...space, reason: e.target.value })} />
            </div>
            <p className="muted">Changing the target space is a design change: the sign-off must be renewed.</p>
            {error && <div className="error">{error}</div>}
            <div className="row end">
              <button className="btn" onClick={() => setSpace(undefined)}>Cancel</button>
              <button className="btn primary" onClick={async () => {
                try {
                  await call('setSpace', { blueprintId, designId: space.designId, mode: space.mode, ...(space.key ? { key: space.key } : {}), ...(space.mode === 'new' && space.name ? { name: space.name } : {}), ...(space.reason ? { reason: space.reason } : {}) });
                  setSpace(undefined); await onChanged();
                } catch (e) { setError((e as Error).message); }
              }}>Save</button>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Build state on {st.site}</h3>
        {!st.exists ? <p className="muted">Nothing built yet.</p> : (
          <>
            <p>{st.elements.recorded} of {st.elements.inDesign} elements recorded: {Object.entries(st.elements.byStatus as Record<string, number>).map(([k, v]) => `${v} ${k}`).join(', ')}</p>
            {st.failed.length > 0 && <div className="error">{st.failed.map((f: any) => `${f.designId}: ${f.error}`).join('\n')}</div>}
          </>
        )}
      </div>
    </div>
  );
}

type Choice = 'keep' | 'reject' | 'defer' | 'reinstate';

function SignOff({ blueprintId, onChanged }: { blueprintId: string; onChanged: () => Promise<void> }) {
  const [review, setReview] = useState<any>();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<any>();
  const load = useCallback(async () => {
    try { setReview(await call('signOffReview', { blueprintId })); setChoices({}); } catch (e) { setError((e as Error).message); }
  }, [blueprintId]);
  useEffect(() => { void load(); }, [load]);
  if (error && !review) return <div className="error">{error}</div>;
  if (!review) return <p className="muted">Loading the review…</p>;
  const pick = (c: Choice) => Object.entries(choices).filter(([, v]) => v === c).map(([k]) => k);
  return (
    <div>
      <p>Review every outcome and its acceptance criteria. Outcomes still proposed are confirmed unless you reject or defer them. Sign-off is recorded under your Atlassian account.</p>
      {review.outcomes.map((o: any) => (
        <div key={o.id} className="card">
          <div className="row"><strong>{o.category}</strong><span>{o.statement}</span><span className="lozenge">{o.status}</span><span className="muted">{o.priority}</span></div>
          <ul>{o.criteria.map((c: any) => <li key={c.id}><code>{c.id.split('.').at(-1)}</code> ({c.verification}) Given {c.given}; when {c.when}; then {c.then.join('; ')}.</li>)}</ul>
          <div className="row">
            {(['keep', 'reject', 'defer', ...(o.status === 'rejected' || o.status === 'deferred' ? ['reinstate'] : [])] as Choice[]).map((c) => (
              <label key={c}><input type="radio" name={o.id} checked={(choices[o.id] ?? 'keep') === c} onChange={() => setChoices({ ...choices, [o.id]: c })} /> {c}</label>
            ))}
          </div>
        </div>
      ))}
      <input className="input wide" placeholder="comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      {done && <div className="notice">{done.next}</div>}
      {error && <div className="error">{error}</div>}
      <div className="row end"><button className="btn primary" onClick={() => setDialog(true)}>Sign off…</button></div>
      {dialog && (
        <PhraseDialog
          title="Sign off the outcomes" action="Sign off"
          explain={`You approve these outcomes and the design for ${review.blueprint} (signHash ${review.signHash}). Any later change makes the sign-off stale.`}
          phrase={review.phrase}
          onConfirm={async (typed) => {
            const r = await call('signOff', { blueprintId, signHash: review.signHash, confirm: typed, reject: pick('reject'), defer: pick('defer'), reinstate: pick('reinstate'), ...(comment ? { comment } : {}) });
            setDone(r); await load(); await onChanged();
          }}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  );
}

function Build({ boot, blueprintId, jobs, onChanged }: { boot: Boot; blueprintId: string; jobs: Job[]; onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState<Job>();
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const isAdmin = boot.role === 'admin';
  const active = jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const lastDryRun = jobs.find((j) => j.op === 'dry-run' && j.status === 'done');

  const open = useCallback(async (jobId: string) => {
    clearTimeout(timer.current);
    try {
      const j = await call<Job>('job', { blueprintId, jobId });
      setCurrent(j);
      if (j.status === 'queued' || j.status === 'running') timer.current = setTimeout(() => void open(jobId), 3000);
      else await onChanged();
    } catch (e) { setError((e as Error).message); }
  }, [blueprintId, onChanged]);
  useEffect(() => {
    const first = active ?? jobs[0];
    if (first && !current) void open(first.id);
    return () => clearTimeout(timer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (op: 'dry-run' | 'verify' | 'apply', extra: Record<string, unknown> = {}) => {
    setError(undefined);
    const j = await call<Job>('startJob', { blueprintId, op, ...extra });
    await onChanged(); await open(j.id);
  };
  const r = current?.status === 'done' ? current.result : undefined;
  const reviewed = current?.op === 'dry-run' && r?.phrase ? r : undefined;

  return (
    <div>
      {isAdmin && (
        <div className="row">
          <button className="btn primary" disabled={Boolean(active)} onClick={() => start('dry-run').catch((e) => setError(e.message))}>Dry-run</button>
          <button className="btn" disabled={Boolean(active)} onClick={() => start('verify').catch((e) => setError(e.message))}>Verify</button>
          {reviewed && <button className="btn danger" disabled={Boolean(active)} onClick={() => setDialog(true)}>Apply this dry-run…</button>}
          {!boot.writeAllowed && <span className="muted">Apply is off: this site is not a designated sandbox.</span>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <table className="grid"><thead><tr><th>Job</th><th>Status</th><th>Queued</th><th>Finished</th><th /></tr></thead><tbody>
        {jobs.map((j) => (
          <tr key={j.id}><td>{j.op}{j.planHash ? <> <code>{j.planHash}</code></> : null}</td>
            <td><span className={j.status === 'done' ? 'lozenge ok' : j.status === 'failed' ? 'lozenge bad' : 'lozenge warn'}>{j.status}</span></td>
            <td>{new Date(j.queuedAt).toLocaleString()}</td><td>{j.finishedAt ? new Date(j.finishedAt).toLocaleString() : '—'}</td>
            <td><button className="btn" onClick={() => void open(j.id)}>Open</button></td></tr>
        ))}
      </tbody></table>
      {current && (
        <div className="card">
          <h3>{current.op} · {current.status}</h3>
          {current.error && <div className="error">{current.error}</div>}
          {(current.status === 'queued' || current.status === 'running') && <p className="muted">Working… this page refreshes by itself.</p>}
          {r?.apply && <div className="notice">{r.apply}</div>}
          {r?.failed?.length > 0 && <div className="error">{r.failed.map((f: any) => `${f.designId}: ${f.detail}`).join('\n')}</div>}
          {r?.markdown && <Markdown text={r.markdown} />}
        </div>
      )}
      {!current && lastDryRun && <p className="muted">Open a job to see its report.</p>}
      {dialog && reviewed && (
        <PhraseDialog
          title="Apply the reviewed dry-run" danger action="Apply"
          explain={`This builds on ${boot.site}: ${reviewed.summary ? Object.entries(reviewed.summary).map(([k, v]) => `${v} ${k}`).join(', ') : ''}. The dry-run is repeated first; if anything changed since you reviewed it, nothing is built.`}
          phrase={reviewed.phrase}
          onConfirm={async (typed) => start('apply', { planHash: reviewed.planHash, confirm: typed })}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  );
}

function Steps({ boot, blueprintId }: { boot: Boot; blueprintId: string }) {
  const [steps, setSteps] = useState<any>();
  const [error, setError] = useState<string>();
  const [form, setForm] = useState<Record<string, { remoteId: string; remoteKey: string; note: string }>>({});
  const load = useCallback(async () => {
    try { setSteps(await call('manualSteps', { blueprintId })); } catch (e) { setError((e as Error).message); }
  }, [blueprintId]);
  useEffect(() => { void load(); }, [load]);
  if (!steps) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  if (!steps.count) return <p>No guided steps pending.</p>;
  return (
    <div>
      <p>{steps.count} step(s) need a person in the Jira UI. When one is done, record it so the next dry-run can continue from it.</p>
      {error && <div className="error">{error}</div>}
      {steps.steps.map((s: any) => {
        const f = form[s.designId] ?? { remoteId: '', remoteKey: '', note: '' };
        const set = (p: Partial<typeof f>) => setForm({ ...form, [s.designId]: { ...f, ...p } });
        return (
          <div key={s.designId} className="card">
            <Markdown text={s.markdown} />
            {boot.role === 'admin' && (
              <div className="row">
                {s.record !== 'none' && <input className="input" placeholder={s.record === 'remote-id' ? 'id on the site (required)' : 'id on the site'} value={f.remoteId} onChange={(e) => set({ remoteId: e.target.value })} />}
                <input className="input" placeholder="key (optional)" value={f.remoteKey} onChange={(e) => set({ remoteKey: e.target.value })} />
                <input className="input" placeholder="note (optional)" value={f.note} onChange={(e) => set({ note: e.target.value })} />
                <button className="btn primary" onClick={async () => {
                  try {
                    await call('confirmManual', { blueprintId, designId: s.designId, ...(f.remoteId ? { remoteId: f.remoteId } : {}), ...(f.remoteKey ? { remoteKey: f.remoteKey } : {}), ...(f.note ? { note: f.note } : {}) });
                    setError(undefined); await load();
                  } catch (e) { setError((e as Error).message); }
                }}>Mark done</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Acceptance({ blueprintId }: { blueprintId: string }) {
  const [plan, setPlan] = useState<any>();
  const [error, setError] = useState<string>();
  useEffect(() => { call('acceptancePlan', { blueprintId }).then(setPlan, (e) => setError(e.message)); }, [blueprintId]);
  if (error) return <div className="error">{error}</div>;
  if (!plan) return <p className="muted">Planning the acceptance tests…</p>;
  return (
    <div>
      <div className="notice">{plan.run}</div>
      <p>{Object.entries(plan.summary).map(([k, v]) => `${v} ${k}`).join(', ')}</p>
      <Markdown text={plan.markdown} />
    </div>
  );
}
