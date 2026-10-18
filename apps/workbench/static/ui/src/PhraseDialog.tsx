import { useState } from 'react';

/**
 * The person types the gate phrase themselves (no paste-to-confirm shortcut is offered). The button only enables on
 * an exact match, but this is convenience: the server checks the phrase again and decides.
 */
export function PhraseDialog(props: { title: string; explain: string; phrase: string; action: string; danger?: boolean; onConfirm: (typed: string) => Promise<void>; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const match = typed.trim() === props.phrase;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="phrase-title">
      <div className="dialog">
        <h3 id="phrase-title">{props.title}</h3>
        <p>{props.explain}</p>
        <p>Type exactly:</p>
        <p className="phrase" aria-label="phrase to type">{props.phrase}</p>
        <input
          className="input wide" autoFocus value={typed} spellCheck={false} autoComplete="off"
          onPaste={(e) => e.preventDefault()} onChange={(e) => setTyped(e.target.value)} aria-label="confirmation phrase"
        />
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button className="btn" onClick={props.onClose} disabled={busy}>Cancel</button>
          <button
            className={props.danger ? 'btn danger' : 'btn primary'} disabled={!match || busy}
            onClick={async () => {
              setBusy(true); setError(undefined);
              try { await props.onConfirm(typed.trim()); props.onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
            }}
          >{busy ? 'Working…' : props.action}</button>
        </div>
      </div>
    </div>
  );
}
