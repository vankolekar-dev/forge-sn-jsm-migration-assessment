import { XMLParser } from 'fast-xml-parser';
import type { SnRecord } from '../types';
import { isRecordTable } from './tables';

export interface XmlParseResult {
  records: SnRecord[];
  updateSetNames: string[];
  warnings: string[];
  /** Record-like elements from tables the collector does not understand, by table (not parsed). */
  skippedTables: Record<string, number>;
}

export const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_DEPTH = 3;

type PNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: '__cdata',
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
});

function tagOf(node: PNode): string | undefined {
  return Object.keys(node).find((k) => k !== ':@');
}

function childrenOf(node: PNode, tag: string): PNode[] {
  const c = node[tag];
  return Array.isArray(c) ? (c as PNode[]) : [];
}

function attrsOf(node: PNode): Record<string, string> {
  return (node[':@'] as Record<string, string>) ?? {};
}

/** Text content of a leaf element (text + CDATA, concatenated). */
function textOf(children: PNode[]): string {
  let out = '';
  for (const ch of children) {
    if ('#text' in ch) out += String(ch['#text'] ?? '');
    else if ('__cdata' in ch) {
      const cd = ch['__cdata'];
      if (Array.isArray(cd)) out += cd.map((x: PNode) => String(x['#text'] ?? '')).join('');
    }
  }
  return out.trim();
}

function hasElementChildren(children: PNode[]): boolean {
  return children.some((ch) => {
    const t = tagOf(ch);
    return t !== undefined && t !== '#text' && t !== '__cdata';
  });
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

export function parseXml(xml: string, filename = 'upload.xml'): XmlParseResult {
  const warnings: string[] = [];
  const records: SnRecord[] = [];
  const updateSetNames: string[] = [];
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new Error(`${filename} is larger than ${MAX_XML_BYTES / 1024 / 1024} MB. Split the export into smaller files.`);
  }
  if (!/^\s*(?:\uFEFF)?</.test(xml)) {
    throw new Error(`${filename} is not an XML file. Export from ServiceNow as XML (list view → Export → XML) or as an update set.`);
  }
  let tree: PNode[];
  try {
    tree = parser.parse(xml) as PNode[];
  } catch (e) {
    throw new Error(`${filename} is not valid XML: ${(e as Error).message}`);
  }
  const seen = new Set<string>();
  const skippedTables: Record<string, number> = {};

  const pushRecord = (rec: SnRecord) => {
    const k = `${rec.table}:${rec.sysId}`;
    if (rec.sysId && seen.has(k)) return;
    seen.add(k);
    records.push(rec);
  };

  const parsePayload = (raw: string, depth: number) => {
    if (!raw || depth > MAX_PAYLOAD_DEPTH) return;
    // Payloads may be escaped more than once (e.g. "&lt;?xml" after the first decode).
    let payload = raw.trim();
    for (let i = 0; i < 3 && !payload.startsWith('<') && payload.includes('&lt;'); i++) {
      payload = decodeEntities(payload).trim();
    }
    try {
      walk(parser.parse(payload) as PNode[], depth + 1);
    } catch {
      warnings.push('An update-set payload could not be parsed and was skipped.');
    }
  };

  const toRecord = (table: string, children: PNode[], attrs: Record<string, string>): SnRecord => {
    const fields: Record<string, string> = {};
    for (const ch of children) {
      const t = tagOf(ch);
      if (!t || t === '#text' || t === '__cdata') continue;
      const grand = childrenOf(ch, t);
      if (hasElementChildren(grand)) continue; // nested record — handled by walk()
      fields[t] = textOf(grand);
      const disp = attrsOf(ch)['display_value'];
      if (disp) fields[`${t}__display`] = disp;
    }
    const scn = fields['sys_class_name'];
    const effective = scn && isRecordTable(scn) ? scn : table;
    return {
      table: effective,
      sysId: fields['sys_id'] || attrs['sys_id'] || `${effective}-${records.length + 1}`,
      fields,
    };
  };

  function walk(nodes: PNode[], depth: number) {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (!tag || tag === '#text' || tag === '__cdata') continue;
      const children = childrenOf(node, tag);
      const attrs = attrsOf(node);

      if (tag === 'sys_update_xml') {
        const rec = toRecord(tag, children, attrs);
        parsePayload(rec.fields['payload'] ?? '', depth);
        continue;
      }
      if (tag === 'sys_remote_update_set' || tag === 'sys_update_set') {
        const rec = toRecord(tag, children, attrs);
        if (rec.fields['name']) updateSetNames.push(rec.fields['name']);
        walk(children, depth);
        continue;
      }

      const leafFields = children.filter((ch) => {
        const t = tagOf(ch);
        return t && t !== '#text' && t !== '__cdata';
      });
      const looksLikeRecord = leafFields.length > 0;
      let classTable: string | undefined;
      if (looksLikeRecord && !isRecordTable(tag)) {
        // Unknown wrapper tag that carries its own sys_class_name (compound payloads).
        const scnNode = leafFields.find((ch) => tagOf(ch) === 'sys_class_name');
        if (scnNode) {
          const scn = textOf(childrenOf(scnNode, 'sys_class_name'));
          if (isRecordTable(scn)) classTable = scn;
        }
      }
      if (looksLikeRecord && (isRecordTable(tag) || classTable)) {
        pushRecord(toRecord(classTable ?? tag, children, attrs));
      } else if (looksLikeRecord && !leafFields.some((ch) => hasElementChildren(childrenOf(ch, tagOf(ch)!)))) {
        skippedTables[tag] = (skippedTables[tag] ?? 0) + 1;
      }
      // Always descend: compound payloads nest records inside records.
      if (hasElementChildren(children)) walk(children, depth);
    }
  }

  walk(tree, 0);
  const skipped = Object.entries(skippedTables);
  if (skipped.length) {
    warnings.push(`Skipped ${skipped.reduce((n, [, c]) => n + c, 0)} record(s) from tables the collector does not read: ${skipped.map(([t, c]) => `${t} (${c})`).join(', ')}.`);
  }
  if (records.length === 0) {
    warnings.push(`${filename}: no recognised ServiceNow records found. Export tables as XML (list view → Export → XML) or as an update set.`);
  }
  return { records, updateSetNames, warnings, skippedTables };
}
