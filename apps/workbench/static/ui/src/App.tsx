import { useCallback, useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { call, uploadBlueprint, type Boot } from './api';
import { BlueprintView } from './BlueprintView';
import { SettingsView } from './SettingsView';
import { ServiceNowView } from './ServiceNowView';
import { DemoConnectionView } from './DemoConnectionView';
import { BlueprintPicker, JsmBuildGaps, ServiceNowComponents } from './ComponentsView';

type Page = 'blueprints' | 'sn-components' | 'jsm-gaps' | 'servicenow' | 'servicenow-demo';

export function App() {
  const [boot, setBoot] = useState<Boot>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [adminPage, setAdminPage] = useState(false);
  const [page, setPage] = useState<Page>('blueprints');

  const reload = useCallback(async () => {
    try {
      const b = await call<Boot>('bootstrap');
      setBoot(b);
      setSelected((s) => s ?? b.blueprints[0]?.id);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    view.getContext().then((c) => setAdminPage(String(c.moduleKey ?? '').endsWith('-settings'))).catch(() => undefined);
    void reload();
  }, [reload]);

  if (error && !boot) return <div className="app"><div className="error">{error}</div></div>;
  if (!boot) return <div className="app muted">Loading…</div>;
  if (boot.role === 'none') {
    return <div className="app"><h1>ServiceNow → JSM workbench</h1><div className="notice">You do not have access. A Jira administrator can add you as a signer in the workbench settings.</div></div>;
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>ServiceNow → JSM workbench</h1>
          <div className="muted">{boot.site} · you are {boot.role === 'admin' ? 'a Jira administrator' : 'a signer'}</div>
        </div>
        <span className={boot.writeAllowed ? 'lozenge warn' : 'lozenge'}>{boot.writeAllowed ? 'sandbox: builds allowed' : 'read-only: not a designated sandbox'}</span>
      </header>
      {error && <div className="error">{error}</div>}
      {adminPage
        ? (boot.role === 'admin' ? <SettingsView boot={boot} onSaved={setBoot} /> : <div className="notice">Only Jira administrators can change the workbench settings.</div>)
        : (<>
          <nav className="tabs">
            {PAGES.filter(([, , adminOnly]) => !adminOnly || boot.role === 'admin').map(([p, label]) => (
              <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>{label}</button>
            ))}
          </nav>
          {(page === 'sn-components' || page === 'jsm-gaps') && (
            <div>
              <BlueprintPicker blueprints={boot.blueprints} selected={selected} onSelect={setSelected} />
              {page === 'sn-components' ? <ServiceNowComponents blueprintId={selected} /> : <JsmBuildGaps blueprintId={selected} />}
            </div>
          )}
          {page === 'servicenow-demo' && boot.role === 'admin' && <DemoConnectionView onBlueprint={async (id) => { await reload(); setSelected(id); setPage('blueprints'); }} />}
          {page === 'servicenow' && boot.role === 'admin' && <ServiceNowView onBlueprint={async (id) => { await reload(); setSelected(id); setPage('blueprints'); }} />}
          {page === 'blueprints' && (
          <div className="layout">
            <aside>
              <h3>Blueprints</h3>
              {!boot.blueprints.length && <p className="muted">No blueprints yet.</p>}
              <ul className="list">
                {boot.blueprints.map((b) => (
                  <li key={b.id}>
                    <button className={b.id === selected ? 'selected' : ''} onClick={() => setSelected(b.id)}>
                      <div><strong>{b.customer}</strong> <span className={b.signedOff ? 'lozenge ok' : 'lozenge'}>{b.signedOff ? 'signed off' : 'not signed off'}</span></div>
                      <div className="muted">{b.id}</div>
                      {b.source && <div className="muted">from {b.source}</div>}
                    </button>
                  </li>
                ))}
              </ul>
              {boot.role === 'admin' && <Upload partChars={boot.partChars} onDone={async (id) => { await reload(); setSelected(id); }} />}
            </aside>
            <main>{selected ? <BlueprintView key={selected} boot={boot} blueprintId={selected} onChanged={reload} /> : <p className="muted">Upload a Migration Blueprint (blueprint.json from the analyser), or connect to ServiceNow and collect one, to start.</p>}</main>
          </div>
            )}
        </>)}
    </div>
  );
}

const PAGES: [Page, string, boolean][] = [
  ['blueprints', 'Blueprints', false],
  ['sn-components', 'ServiceNow components', false],
  ['jsm-gaps', 'JSM build & gaps', false],
  ['servicenow', 'Connect to ServiceNow', true],
  ['servicenow-demo', 'ServiceNow demo (basic auth)', true],
];

function Upload({ partChars, onDone }: { partChars: number; onDone: (id: string) => Promise<void> }) {
  const [progress, setProgress] = useState<[number, number]>();
  const [error, setError] = useState<string>();
  const [replace, setReplace] = useState(false);
  return (
    <div className="card">
      <h4>Upload a blueprint</h4>
      <input
        type="file" accept="application/json,.json" disabled={Boolean(progress)}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setError(undefined); setProgress([0, 1]);
          try {
            const r = await uploadBlueprint(await file.text(), file.name, partChars, replace, (d, t) => setProgress([d, t]));
            await onDone(r.blueprintId);
          } catch (err) { setError((err as Error).message); } finally { setProgress(undefined); }
        }}
      />
      <label className="row"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> replace a blueprint with the same id</label>
      {progress && <progress max={progress[1]} value={progress[0]} />}
      {error && <div className="error">{error}</div>}
      <p className="muted">A sign-off made elsewhere is not carried over: outcomes are signed off again here.</p>
    </div>
  );
}
