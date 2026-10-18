import { Fragment, type ReactNode } from 'react';

/**
 * Minimal Markdown for the workflow's reports: headings, lists, fenced code, tables, rules, **bold** and `code`.
 * Builds React elements only (no HTML strings), so text from a blueprint can never inject markup.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) body.push(lines[i]!);
      i++;
      out.push(<pre key={k++} className="md-code">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1]!.length + 1, 5);
      const Tag = `h${level}` as 'h2';
      out.push(<Tag key={k++}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!); i++) items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(<ul key={k++}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ul>);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith('|'); i++) {
        if (/^\|[\s:|-]+\|?$/.test(lines[i]!)) continue;
        rows.push(lines[i]!.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      }
      const [head, ...body] = rows;
      out.push(
        <table key={k++} className="md-table">
          {head && <thead><tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr></thead>}
          <tbody>{body.map((r, n) => <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    if (/^---+$/.test(line.trim())) { out.push(<hr key={k++} />); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\||\s*([-*]|\d+\.)\s+|---+$)/.test(lines[i]!); i++) para.push(lines[i]!);
    out.push(<p key={k++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{out}</div>;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, n) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 1 ? <code key={n}>{p.slice(1, -1)}</code>
      : p.startsWith('**') && p.endsWith('**') && p.length > 3 ? <strong key={n}>{p.slice(2, -2)}</strong>
        : <Fragment key={n}>{p}</Fragment>,
  );
}
