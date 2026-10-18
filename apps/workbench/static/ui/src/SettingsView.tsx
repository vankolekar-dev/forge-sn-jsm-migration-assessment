import { useState } from 'react';
import { call, type Boot } from './api';
import { PhraseDialog } from './PhraseDialog';

export function SettingsView({ boot, onSaved }: { boot: Boot; onSaved: (b: Boot) => void }) {
  const s = boot.settings!;
  const [signers, setSigners] = useState(s.signers.join(', '));
  const [actAs, setActAs] = useState(s.actAs);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const save = async (payload: Record<string, unknown>) => {
    setError(undefined); setSaved(false);
    try { onSaved(await call<Boot>('saveSettings', payload)); setSaved(true); } catch (e) { setError((e as Error).message); throw e; }
  };
  return (
    <div>
      <div className="card">
        <h3>Sandbox designation</h3>
        <p>Builds (apply) only run on a site a Jira administrator designated as a sandbox. Dry-runs, verify and guided steps work everywhere.</p>
        {s.sandbox
          ? <div className="row"><span className="lozenge warn">designated</span><span className="muted">{s.sandbox.site} by {s.sandbox.by} at {s.sandbox.at}</span><button className="btn" onClick={() => save({ sandbox: { designate: false } }).catch(() => undefined)}>Remove designation</button></div>
          : <button className="btn danger" onClick={() => setDialog(true)}>Designate this site as a sandbox…</button>}
      </div>
      <div className="card">
        <h3>Signers</h3>
        <p>Atlassian account ids (comma-separated) who may read blueprints and sign off outcomes. Jira administrators always can.</p>
        <input className="input wide" value={signers} onChange={(e) => setSigners(e.target.value)} placeholder="557058:…, 712020:…" />
        <h3>Jobs act as</h3>
        <label className="row"><input type="radio" checked={actAs === 'user'} onChange={() => setActAs('user')} /> the person who started the job (recommended: site changes are audited under their name)</label>
        <label className="row"><input type="radio" checked={actAs === 'app'} onChange={() => setActAs('app')} /> the app (use if your site does not allow the app to act as users in the background)</label>
        <div className="row end">
          <button className="btn primary" onClick={() => save({ signers: signers.split(',').map((x) => x.trim()).filter(Boolean), actAs }).catch(() => undefined)}>Save</button>
        </div>
        {saved && <div className="notice">Saved.</div>}
      </div>
      {error && <div className="error">{error}</div>}
      {dialog && (
        <PhraseDialog
          title="Designate a sandbox" danger action="Designate"
          explain={`After this, Jira administrators can build reviewed, signed-off dry-runs on ${boot.site}: it creates spaces, fields, request types and Assets schemas. Only do this on a sandbox or pre-production site.`}
          phrase={boot.designatePhrase}
          onConfirm={async (typed) => save({ sandbox: { designate: true, confirm: typed } })}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  );
}
