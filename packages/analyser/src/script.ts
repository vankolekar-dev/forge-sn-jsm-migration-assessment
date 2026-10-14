/**
 * Static analysis of ServiceNow JavaScript (business rules, client scripts, script includes, ACLs, scheduled jobs,
 * widgets, flow/workflow scripts). Regex-based by design: it must tolerate partial and invalid scripts, and it
 * only needs to answer "what does this touch and what is it for", not execute anything.
 */
export type ScriptPattern =
  | 'validation' | 'abort' | 'field-default' | 'calculation' | 'auto-assignment' | 'approval' | 'notification'
  | 'integration' | 'cascade-update' | 'record-creation' | 'record-deletion' | 'visibility' | 'mandatory'
  | 'read-only' | 'message' | 'access-check' | 'choice-manipulation' | 'logging-only' | 'scheduling' | 'data-lookup';

export type AntiPattern =
  | 'client-glide-record' | 'sync-ajax' | 'hardcoded-sys-id' | 'eval' | 'current-update-in-rule' | 'query-in-loop'
  | 'dom-manipulation' | 'sleep' | 'no-query-limit' | 'hardcoded-url' | 'hardcoded-credentials';

export interface ScriptAnalysis {
  lines: number;
  complexity: number;
  tables: string[];
  scriptIncludes: string[];
  events: string[];
  restMessages: { name: string; method?: string }[];
  soapMessages: string[];
  ajax: string[];
  fieldsSet: string[];
  fieldsRead: string[];
  form: { mandatory: string[]; visible: string[]; readOnly: string[]; values: string[] };
  roles: string[];
  hardcodedSysIds: number;
  urls: string[];
  patterns: ScriptPattern[];
  antiPatterns: AntiPattern[];
  /** First meaningful comment, often the author's own description. */
  comment?: string;
}

const PLATFORM_CLASSES = new Set([
  'GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideAjax', 'GlideDateTime', 'GlideDate', 'GlideTime', 'GlideDuration',
  'GlideSysAttachment', 'GlideEmailOutbound', 'GlideFilter', 'GlideSchedule', 'GlideUser', 'GlideElement', 'GlideappCalculationHelper',
  'GlideDialogWindow', 'GlideModal', 'GlideList2', 'GlideForm', 'GlideURL', 'GlideStringUtil', 'GlideTableHierarchy', 'GlideScopedEvaluator',
  'Array', 'Object', 'Date', 'RegExp', 'Error', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Class', 'Promise', 'Map', 'Set', 'XMLDocument', 'XMLDocument2',
  'AbstractAjaxProcessor', 'RESTMessageV2', 'SOAPMessageV2', 'Workflow', 'ArrayUtil', 'JSUtil', 'GlideSecureRandomUtil', 'GlideDigest', 'GlideEncrypter',
]);

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const all = (s: string, re: RegExp, g = 1) => [...s.matchAll(re)].map((m) => m[g]!).filter(Boolean);

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');
}

export function analyseScript(src: string | undefined, context: 'server' | 'client' | 'acl' = 'server'): ScriptAnalysis | undefined {
  if (!src || !src.trim()) return undefined;
  const code = stripComments(src);
  const comment = src.match(/^\s*(?:\/\/\s*(.+)|\/\*+\s*([\s\S]*?)\*\/)/)?.slice(1).find(Boolean)?.split('\n')[0]?.replace(/^\*\s*/, '').trim();

  const tables = uniq(all(code, /new\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(\s*['"]([a-z0-9_]+)['"]/g));
  const scriptIncludes = uniq([
    ...all(code, /new\s+(?:global\.|[a-z_]+\.)?([A-Z][A-Za-z0-9_]*)\s*\(/g),
    ...all(code, /\b([A-Z][A-Za-z0-9_]*Utils?|[A-Z][A-Za-z0-9_]*Helper|[A-Z][A-Za-z0-9_]*Service)\.[a-z]\w*\s*\(/g),
  ].filter((c) => !PLATFORM_CLASSES.has(c) && !c.startsWith('Glide')));
  const events = uniq(all(code, /gs\.eventQueue(?:Scheduled)?\s*\(\s*['"]([^'"]+)['"]/g));
  const restMessages = [...code.matchAll(/RESTMessageV2\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/g)].map((m) => ({ name: m[1]!, method: m[2] }));
  const soapMessages = uniq(all(code, /SOAPMessageV2\s*\(\s*['"]([^'"]+)['"]/g));
  const ajax = uniq(all(code, /new\s+GlideAjax\s*\(\s*['"]([^'"]+)['"]/g));
  const fieldsSet = uniq([
    ...all(code, /\bcurrent\.([a-z_][a-z0-9_]*)\s*=(?!=)/g),
    ...all(code, /\bcurrent\.setValue\s*\(\s*['"]([^'"]+)['"]/g),
    ...all(code, /\bg_form\.setValue\s*\(\s*['"]([^'"]+)['"]/g),
  ]);
  const fieldsRead = uniq([
    ...all(code, /\bcurrent\.([a-z_][a-z0-9_]*)\b(?!\s*=[^=])/g),
    ...all(code, /\bg_form\.getValue\s*\(\s*['"]([^'"]+)['"]/g),
  ]).filter((f) => !['update', 'insert', 'setValue', 'getValue', 'setAbortAction', 'isNewRecord', 'changes', 'operation', 'getDisplayValue', 'addQuery', 'query', 'next', 'get', 'sys_id'].includes(f));
  const form = {
    mandatory: uniq(all(code, /g_form\.setMandatory\s*\(\s*['"]([^'"]+)['"]/g)),
    visible: uniq(all(code, /g_form\.set(?:Display|Visible)\s*\(\s*['"]([^'"]+)['"]/g)),
    readOnly: uniq(all(code, /g_form\.set(?:ReadOnly|ReadOnly|Disabled)\s*\(\s*['"]([^'"]+)['"]/g)),
    values: uniq(all(code, /g_form\.setValue\s*\(\s*['"]([^'"]+)['"]/g)),
  };
  const roles = uniq(all(code, /hasRole(?:Exactly)?\s*\(\s*['"]([^'"]+)['"]/g));
  const hardcodedSysIds = (code.match(/['"][0-9a-f]{32}['"]/g) ?? []).length;
  const urls = uniq(all(code, /['"](https?:\/\/[^'"\s]+)['"]/g));

  const has = (re: RegExp) => re.test(code);
  const patterns: ScriptPattern[] = [];
  const p = (cond: boolean, pat: ScriptPattern) => cond && patterns.push(pat);
  p(has(/setAbortAction\s*\(\s*true/) || (context === 'client' && has(/return\s+false/)), 'abort');
  p(has(/addErrorMessage|showFieldMsg\s*\([^)]*['"]error['"]|g_form\.addErrorMessage/) || has(/setAbortAction/), 'validation');
  p(has(/assignment_group|assigned_to/) && (fieldsSet.includes('assignment_group') || fieldsSet.includes('assigned_to') || has(/setValue\s*\(\s*['"]assign/)), 'auto-assignment');
  p(has(/sysapproval|approval|approver/i) && has(/insert\(|setValue|approval\s*=|\.approval\b/), 'approval');
  p(events.length > 0 || has(/GlideEmailOutbound|email\.(addAddress|setSubject)|template\.print/), 'notification');
  p(restMessages.length > 0 || soapMessages.length > 0 || has(/sn_ws\.|GlideHTTPRequest|RESTAPIRequest|\$http|fetch\(/), 'integration');
  p(tables.length > 0 && has(/\.update\(\)/) && !has(/current\.update\(\)/), 'cascade-update');
  p(has(/\.initialize\(\)|\.insert\(\)/) && !has(/current\.insert\(\)/), 'record-creation');
  p(has(/\.deleteRecord\(\)|\.deleteMultiple\(\)/), 'record-deletion');
  p(form.visible.length > 0, 'visibility');
  p(form.mandatory.length > 0, 'mandatory');
  p(form.readOnly.length > 0, 'read-only');
  p(has(/addInfoMessage|showFieldMsg|g_form\.addInfoMessage|alert\(/), 'message');
  p(roles.length > 0 || has(/answer\s*=|canRead|canWrite|isMemberOf/), 'access-check');
  p(has(/addOption|clearOptions|removeOption/), 'choice-manipulation');
  p(has(/GlideDateTime|GlideSchedule|addDays|addSeconds|dateDiff/) && fieldsSet.length > 0, 'scheduling');
  p(has(/[*+\-/]\s*(?:parseFloat|parseInt|Number)|\.toFixed\(|calculat/i) && fieldsSet.length > 0, 'calculation');
  p(fieldsSet.length > 0 && !patterns.includes('auto-assignment') && !patterns.includes('calculation') && (has(/isNewRecord|onLoad|operation\s*\(\)\s*==\s*['"]insert/) || context === 'client'), 'field-default');
  p(has(/DecisionTable|sn_dt\.|getMatchingRecords|dl_definition/), 'data-lookup');
  if (!patterns.length && has(/gs\.(log|info|debug|warn|error|print)\s*\(/)) patterns.push('logging-only');

  const antiPatterns: AntiPattern[] = [];
  const a = (cond: boolean, ap: AntiPattern) => cond && antiPatterns.push(ap);
  a(context === 'client' && has(/new\s+GlideRecord\s*\(/), 'client-glide-record');
  a(has(/getXMLWait\s*\(|getXMLAnswer\s*\([^)]*false/), 'sync-ajax');
  a(hardcodedSysIds > 0, 'hardcoded-sys-id');
  a(has(/\beval\s*\(|GlideEvaluator|new\s+Function\s*\(/), 'eval');
  a(has(/current\.update\s*\(\s*\)/), 'current-update-in-rule');
  a(has(/while\s*\([^)]*\.next\(\)\)[\s\S]{0,400}?new\s+Glide(?:Record|Aggregate)/), 'query-in-loop');
  a(context === 'client' && has(/document\.|\$\(|jQuery|getElementById|\$j\(/), 'dom-manipulation');
  a(has(/gs\.sleep\s*\(/), 'sleep');
  a(tables.length > 0 && has(/\.query\(\)/) && !has(/setLimit\s*\(|\.get\s*\(|addQuery\s*\(|addEncodedQuery\s*\(/), 'no-query-limit');
  a(urls.length > 0, 'hardcoded-url');
  a(has(/(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{4,}['"]/i), 'hardcoded-credentials');

  const decision = (code.match(/\b(if|for|while|case|catch)\b|\?[^:]|&&|\|\|/g) ?? []).length;
  return {
    lines: src.split('\n').filter((l) => l.trim()).length,
    complexity: 1 + decision,
    tables, scriptIncludes, events, restMessages, soapMessages, ajax, fieldsSet, fieldsRead, form, roles, hardcodedSysIds, urls,
    patterns: uniq(patterns), antiPatterns: uniq(antiPatterns), comment,
  };
}

const INTENT_TEXT: Record<ScriptPattern, string> = {
  validation: 'validates input', abort: 'blocks the action when conditions fail', 'field-default': 'sets default values',
  calculation: 'calculates values', 'auto-assignment': 'assigns work automatically', approval: 'manages approvals',
  notification: 'sends notifications / raises events', integration: 'calls an external system', 'cascade-update': 'updates related records',
  'record-creation': 'creates related records', 'record-deletion': 'deletes records', visibility: 'shows or hides fields',
  mandatory: 'makes fields mandatory', 'read-only': 'makes fields read-only', message: 'shows messages', 'access-check': 'checks access',
  'choice-manipulation': 'changes choice options', 'logging-only': 'only writes logs', scheduling: 'sets dates / schedules', 'data-lookup': 'looks up values from a matrix',
};

/** Plain-language intent from the detected patterns (rules-based; AI enrichment can replace it later). */
export function intentOf(a: ScriptAnalysis | undefined, subject?: string): string | undefined {
  if (!a) return undefined;
  if (!a.patterns.length) return a.comment ? `${a.comment}` : undefined;
  const text = a.patterns.slice(0, 3).map((p) => INTENT_TEXT[p]).join(', ');
  return subject ? `On ${subject}: ${text}` : text[0]!.toUpperCase() + text.slice(1);
}

/** Risk band for one script: drives migration effort and "rebuild vs retire" advice. */
export function scriptRisk(a: ScriptAnalysis | undefined): 'none' | 'low' | 'medium' | 'high' {
  if (!a) return 'none';
  const score = (a.complexity > 25 ? 3 : a.complexity > 10 ? 2 : a.complexity > 4 ? 1 : 0)
    + (a.lines > 150 ? 2 : a.lines > 50 ? 1 : 0)
    + (a.patterns.includes('integration') ? 2 : 0)
    + (a.antiPatterns.filter((x) => x !== 'hardcoded-url').length > 1 ? 1 : 0)
    + (a.scriptIncludes.length > 2 ? 1 : 0);
  return score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
}
