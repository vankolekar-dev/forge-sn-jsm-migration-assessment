import { useEffect, useState } from 'react';
import { call, type BlueprintEntry, type BuildList, type BuildListPage, type JsmGaps, type JsmItem, type Readiness, type SnInventory, type SnItemsPage } from './api';

const PAGE = 200;

export function BlueprintPicker({ blueprints, selected, onSelect }: { blueprints: BlueprintEntry[]; selected?: string; onSelect: (id: string) => void }) {
  if (!blueprints.length) return <p className="muted">No blueprints yet: upload one or collect one from ServiceNow.</p>;
  return (
    <label className="row">
      Blueprint
      <select className="input" value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {blueprints.map((b) => <option key={b.id} value={b.id}>{b.customer} · {b.id}{b.source ? ` · from ${b.source}` : ''}</option>)}
      </select>
    </label>
  );
}

function useLoad<T>(name: string, blueprintId: string | undefined) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!blueprintId) return;
    let live = true;
    setData(undefined); setError(undefined);
    call<T>(name, { blueprintId }).then((d) => { if (live) setData(d); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [name, blueprintId]);
  return { data, error };
}

/** What the analysis found in ServiceNow, by component category. */
export function ServiceNowComponents({ blueprintId }: { blueprintId?: string }) {
  const { data, error } = useLoad<SnInventory>('inventory', blueprintId);
  const [category, setCategory] = useState<string>();
  useEffect(() => { setCategory(undefined); }, [blueprintId]);
  if (error) return <div className="error">{error}</div>;
  if (!blueprintId) return null;
  if (!data) return <p className="muted">Loading…</p>;
  const current = data.categories.find((c) => c.id === category);
  return (
    <div>
      <p className="muted">
        {data.sources.map((s) => `${s.instance ?? s.name}${s.release ? ` (${s.release})` : ''}, ${new Date(s.addedAt).toLocaleDateString()}`).join(' · ')}
      </p>
      <div className="row">
        <Stat n={data.totals.components} label="components" />
        <Stat n={data.totals.custom} label="customer-built" />
        <Stat n={data.totals.scripted} label="with script risk" />
        <Stat n={data.totals.inactive} label="inactive" />
      </div>
      <div className="tiles">
        {data.categories.filter((c) => c.count > 0).map((c) => (
          <button key={c.id} className={c.id === category ? 'tile active' : 'tile'} onClick={() => setCategory(c.id === category ? undefined : c.id)}>
            <div className="tile-n">{c.count}</div>
            <div>{c.label}</div>
            <div className="muted">{c.custom ? `${c.custom} custom` : ''}{c.custom && c.inactive ? ' · ' : ''}{c.inactive ? `${c.inactive} inactive` : ''}</div>
          </button>
        ))}
      </div>
      {data.categories.some((c) => c.count === 0) && (
        <p className="muted">Not found in this source: {data.categories.filter((c) => c.count === 0).map((c) => c.label).join(', ')}.</p>
      )}
      {current && <SnItems key={`${blueprintId}:${current.id}`} blueprintId={blueprintId} category={current.id} label={current.label} byKind={current.byKind} />}
    </div>
  );
}

function SnItems({ blueprintId, category, label, byKind }: { blueprintId: string; category: string; label: string; byKind: Record<string, number> }) {
  const [query, setQuery] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SnItemsPage>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      call<SnItemsPage>('inventoryItems', { blueprintId, category, offset, limit: PAGE, ...(query.trim() ? { query } : {}), ...(customOnly ? { customOnly } : {}) })
        .then((p) => { if (live) { setPage(p); setError(undefined); } }).catch((e: Error) => { if (live) setError(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [blueprintId, category, query, customOnly, offset]);
  return (
    <div className="card">
      <h3>{label}</h3>
      <p className="muted">{Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}</p>
      <div className="row">
        <input className="input" placeholder="Filter by name, purpose or table" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} />
        <label className="row"><input type="checkbox" checked={customOnly} onChange={(e) => { setCustomOnly(e.target.checked); setOffset(0); }} /> customer-built only</label>
      </div>
      {error && <div className="error">{error}</div>}
      {page && (
        <>
          <table className="grid">
            <thead><tr><th>Name</th><th>Type</th><th>What it does</th><th>Table</th><th>Usage</th><th /></tr></thead>
            <tbody>
              {page.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td className="muted">{i.kind}</td>
                  <td>{i.intent ?? <span className="muted">—</span>}</td>
                  <td className="muted">{i.table}</td>
                  <td>{i.usage ? `${i.usage.count}${i.usage.periodDays ? ` in ${i.usage.periodDays} d` : ''}` : ''}{i.fillRate !== undefined ? `${Math.round(i.fillRate * 100)}% filled` : ''}</td>
                  <td>
                    {i.custom && <span className="lozenge warn">custom</span>} {i.active === false && <span className="lozenge">inactive</span>}{' '}
                    {i.risk && <span className={i.risk === 'high' ? 'lozenge bad' : 'lozenge'}>{i.risk} risk</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={page.total} offset={page.offset} size={PAGE} onOffset={setOffset} />
        </>
      )}
    </div>
  );
}

function Pager({ total, offset, size, onOffset }: { total: number; offset: number; size: number; onOffset: (n: number) => void }) {
  if (total <= size) return <p className="muted">{total} shown</p>;
  return (
    <div className="row">
      <button className="btn" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - size))}>Previous</button>
      <span className="muted">{offset + 1}–{Math.min(offset + size, total)} of {total}</span>
      <button className="btn" disabled={offset + size >= total} onClick={() => onOffset(offset + size)}>Next</button>
    </div>
  );
}

const Stat = ({ n, label }: { n: number; label: string }) => <div className="stat"><div className="tile-n">{n}</div><div className="muted">{label}</div></div>;

const WORK_CLASS: Record<string, string> = { Standard: 'lozenge ok', Configure: 'lozenge', 'Build custom': 'lozenge warn' };
const RESOLUTION: Record<string, string> = {
  extension: 'custom JSM configuration', 'marketplace-app': 'Marketplace app', 'forge-app': 'Forge app', integration: 'integration',
  'process-change': 'change the process', 'out-of-scope': 'out of scope', unresolved: 'unresolved: needs a decision',
};

/** What JSM needs, from the blueprint: elements by category, how each is built, and the fit gaps. */
export function JsmBuildGaps({ blueprintId }: { blueprintId?: string }) {
  const { data, error } = useLoad<JsmGaps>('jsmGaps', blueprintId);
  const [category, setCategory] = useState<string>();
  useEffect(() => { setCategory(undefined); }, [blueprintId]);
  if (error) return <div className="error">{error}</div>;
  if (!blueprintId) return null;
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  const current = data.categories.find((c) => c.id === category);
  return (
    <div>
      <p className="muted">From the blueprint only: what the target JSM needs. A dry-run on the Build tab shows what already exists on this site.</p>
      <div className="row">
        <Stat n={t.elements} label="JSM elements" />
        <Stat n={t.standard} label="standard" />
        <Stat n={t.configure} label="configure" />
        <Stat n={t.custom} label="build custom" />
        <Stat n={t.automated + t.partlyGuided} label="built by the workbench" />
        <Stat n={t.guided + t.partlyGuided} label="need guided steps" />
        <Stat n={t.gaps + t.outcomesWithoutElement} label="gaps" />
      </div>
      <div className="tiles">
        {data.categories.map((c) => (
          <button key={c.id} className={c.id === category ? 'tile active' : 'tile'} disabled={!c.count} onClick={() => setCategory(c.id === category ? undefined : c.id)}>
            <div className="tile-n">{c.count}</div>
            <div>{c.label}</div>
            <div className="muted">
              {[c.byOrigin.reference && `${c.byOrigin.reference} standard`, c.byOrigin['reference-configured'] && `${c.byOrigin['reference-configured']} configure`, c.byOrigin.extension && `${c.byOrigin.extension} custom`].filter(Boolean).join(' · ') || 'none needed'}
            </div>
          </button>
        ))}
      </div>
      {current && (
        <div className="card">
          <h3>{current.label}</h3>
          <table className="grid">
            <thead><tr><th>Element</th><th>Work</th><th>How it is built</th><th>Delivers</th><th>Replaces in ServiceNow</th></tr></thead>
            <tbody>{current.items.map((i) => <JsmRow key={i.id} item={i} />)}</tbody>
          </table>
        </div>
      )}
      <div className="card">
        <h3>Gap analysis</h3>
        {!data.gaps.length && !data.outcomesWithoutElement.length && <p className="muted">No gaps: every in-scope outcome is delivered by a JSM element.</p>}
        {data.gaps.length > 0 && (
          <table className="grid">
            <thead><tr><th>Capability</th><th>Gap</th><th>Resolution</th><th>ServiceNow evidence</th></tr></thead>
            <tbody>
              {data.gaps.map((g, n) => (
                <tr key={n}>
                  <td>{g.capability}</td>
                  <td>{g.description}{g.outcome && <div className="muted">Outcome: {g.outcome}</div>}</td>
                  <td><span className={g.resolution === 'unresolved' ? 'lozenge bad' : 'lozenge'}>{RESOLUTION[g.resolution] ?? g.resolution}</span></td>
                  <td className="muted">{g.evidence.slice(0, 5).join(', ')}{g.evidence.length > 5 ? ` and ${g.evidence.length - 5} more` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.outcomesWithoutElement.length > 0 && (
          <>
            <h4>Outcomes no JSM element delivers yet</h4>
            <ul>{data.outcomesWithoutElement.map((o) => <li key={o.id}>{o.statement} <span className="muted">({o.status})</span></li>)}</ul>
          </>
        )}
        <h4>Fit to the Atlassian standard, per capability</h4>
        <table className="grid">
          <thead><tr><th>Capability</th><th>Status</th><th>Fit</th><th>Standard / configured / custom</th></tr></thead>
          <tbody>
            {data.capabilities.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td><td className="muted">{c.status}</td>
                <td>{c.score !== undefined ? <><progress max={100} value={c.score} /> {c.score}%</> : '—'}</td>
                <td className="muted">{c.counts ? `${c.counts.reference} / ${c.counts.configured} / ${c.counts.extension}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ProposedBuildList blueprintId={blueprintId} />
    </div>
  );
}

const READINESS: Record<Readiness, string> = {
  api: 'workbench can build (API)', partial: 'partly by API, rest guided', unknown: 'API not yet verified: guided for now', 'ui-only': 'guided steps in the JSM UI',
  'outside-builder': 'outside this builder', 'no-equivalent': 'no JSM equivalent', 'not-needed': 'not needed in JSM',
};
const READINESS_CLASS: Partial<Record<Readiness, string>> = { api: 'lozenge ok', partial: 'lozenge ok', 'ui-only': 'lozenge warn', unknown: 'lozenge warn', 'no-equivalent': 'lozenge bad' };

/** Everything else ServiceNow has: a first-pass JSM answer per component. Proposed, not reviewed, never built from. */
function ProposedBuildList({ blueprintId }: { blueprintId: string }) {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [data, setData] = useState<BuildList>();
  const [error, setError] = useState<string>();
  const [group, setGroup] = useState<string>();
  useEffect(() => {
    let live = true;
    setData(undefined); setError(undefined);
    call<BuildList>('buildList', { blueprintId, ...(includeInactive ? { includeInactive } : {}) }).then((d) => { if (live) setData(d); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [blueprintId, includeInactive]);
  useEffect(() => { setGroup(undefined); }, [blueprintId]);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading the build list…</p>;
  const t = data.totals;
  const current = data.groups.find((g) => g.id === group);
  return (
    <div className="card">
      <h3>Build list for everything else in ServiceNow <span className="lozenge warn">proposed, not reviewed</span></h3>
      <p className="muted">
        A first-pass JSM answer for each ServiceNow component no capability covers yet. Nobody has checked these mappings, they are not signed off and the workbench never builds from this list:
        bring an item into a capability to build it.
      </p>
      <div className="row">
        <Stat n={t.components} label="ServiceNow components" />
        <Stat n={t.covered} label="covered by the blueprint" />
        {t.outOfScope > 0 && <Stat n={t.outOfScope} label="out of scope" />}
        {t.inactive > 0 && <Stat n={t.inactive} label="inactive, left out" />}
        <Stat n={t.proposed} label="proposed here" />
        <Stat n={t.byReadiness.api + t.byReadiness.partial} label="buildable by API" />
        <Stat n={t.byReadiness.unknown + t.byReadiness['ui-only']} label="guided for now" />
        <Stat n={t.byReadiness['outside-builder'] + t.byReadiness['no-equivalent']} label="outside builder or no equivalent" />
      </div>
      <label className="row"><input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> include inactive components</label>
      <div className="tiles">
        {data.groups.map((g) => (
          <button key={g.id} className={g.id === group ? 'tile active' : 'tile'} onClick={() => setGroup(g.id === group ? undefined : g.id)}>
            <div className="tile-n">{g.count}</div>
            <div>{g.label}</div>
            <div className="muted">{READINESS[g.readiness]}{g.redesign ? ` · ${g.redesign} redesign` : ''}</div>
          </button>
        ))}
      </div>
      {current && <BuildListItems key={`${blueprintId}:${current.id}:${includeInactive}`} blueprintId={blueprintId} group={current} includeInactive={includeInactive} />}
    </div>
  );
}

function BuildListItems({ blueprintId, group, includeInactive }: { blueprintId: string; group: { id: string; label: string; byKind: Record<string, number> }; includeInactive: boolean }) {
  const [query, setQuery] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BuildListPage>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      call<BuildListPage>('buildListItems', { blueprintId, group: group.id, offset, limit: PAGE, ...(query.trim() ? { query } : {}), ...(customOnly ? { customOnly } : {}), ...(includeInactive ? { includeInactive } : {}) })
        .then((p) => { if (live) { setPage(p); setError(undefined); } }).catch((e: Error) => { if (live) setError(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [blueprintId, group.id, query, customOnly, includeInactive, offset]);
  return (
    <div>
      <h4>{group.label}</h4>
      <p className="muted">{Object.entries(group.byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}</p>
      <div className="row">
        <input className="input" placeholder="Filter by name, purpose, table or proposal" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} />
        <label className="row"><input type="checkbox" checked={customOnly} onChange={(e) => { setCustomOnly(e.target.checked); setOffset(0); }} /> customer-built only</label>
      </div>
      {error && <div className="error">{error}</div>}
      {page && (
        <>
          <table className="grid">
            <thead><tr><th>ServiceNow</th><th>Type</th><th>Proposed in JSM</th><th>How it could be built</th><th /></tr></thead>
            <tbody>
              {page.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}{i.intent && <div className="muted">{i.intent}</div>}</td>
                  <td className="muted">{i.kind}{i.table ? ` · ${i.table}` : ''}</td>
                  <td>{i.jsm}{i.note && <div className="muted">{i.note}</div>}</td>
                  <td><span className={READINESS_CLASS[i.readiness] ?? 'lozenge'}>{READINESS[i.readiness]}</span></td>
                  <td>
                    {i.custom && <span className="lozenge warn">custom</span>} {i.redesign && <span className="lozenge">redesign</span>} {i.active === false && <span className="lozenge">inactive</span>}{' '}
                    {i.risk && <span className={i.risk === 'high' ? 'lozenge bad' : 'lozenge'}>{i.risk} risk</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={page.total} offset={page.offset} size={PAGE} onOffset={setOffset} />
        </>
      )}
    </div>
  );
}

function JsmRow({ item: i }: { item: JsmItem }) {
  return (
    <tr>
      <td>{i.name}<div className="muted">{i.type}</div>{i.justification && <div className="muted">Why custom: {i.justification}</div>}</td>
      <td><span className={WORK_CLASS[i.work] ?? 'lozenge'}>{i.work}</span></td>
      <td>{i.method}{i.guidedAspects.length > 0 && <div className="muted">guided: {i.guidedAspects.join(', ')}</div>}</td>
      <td>{i.outcomes.length ? i.outcomes.map((o) => <div key={o.id}>{o.statement}</div>) : <span className="muted">supports other elements</span>}</td>
      <td>
        {i.replaces.count === 0 ? <span className="muted">—</span> : (
          <details>
            <summary>{i.replaces.count} component{i.replaces.count === 1 ? '' : 's'}</summary>
            <ul>{i.replaces.sample.map((s) => <li key={s.id}>{s.name} <span className="muted">({s.kind})</span></li>)}</ul>
            {i.replaces.count > i.replaces.sample.length && <div className="muted">and {i.replaces.count - i.replaces.sample.length} more</div>}
          </details>
        )}
      </td>
    </tr>
  );
}
