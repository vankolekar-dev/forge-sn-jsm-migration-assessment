import type { SnRecord } from '@snjsm/collector';
import { analyseScript, intentOf } from '../script';
import { isTrue, nameOf } from '../store';
import { csv, num, type EvidenceDraft, type ExtractContext, type Extractor, type Relation } from './common';

/** ServiceNow variable type codes → name and the JSM field kind that would deliver the same input. */
export const VARIABLE_TYPES: Record<string, { name: string; jsm: string }> = {
  '1': { name: 'Yes / No', jsm: 'select' }, '2': { name: 'Multi line text', jsm: 'paragraph' }, '3': { name: 'Multiple choice', jsm: 'radio' },
  '4': { name: 'Numeric scale', jsm: 'select' }, '5': { name: 'Select box', jsm: 'select' }, '6': { name: 'Single line text', jsm: 'text' },
  '7': { name: 'Check box', jsm: 'checkbox' }, '8': { name: 'Reference', jsm: 'reference' }, '9': { name: 'Date', jsm: 'date' },
  '10': { name: 'Date / time', jsm: 'datetime' }, '11': { name: 'Label', jsm: 'layout' }, '12': { name: 'Break', jsm: 'layout' },
  '14': { name: 'Custom', jsm: 'unsupported' }, '15': { name: 'UI page', jsm: 'unsupported' }, '16': { name: 'Wide single line text', jsm: 'text' },
  '17': { name: 'Custom with label', jsm: 'unsupported' }, '18': { name: 'Lookup select box', jsm: 'reference' }, '19': { name: 'Container start', jsm: 'layout' },
  '20': { name: 'Container end', jsm: 'layout' }, '21': { name: 'List collector', jsm: 'multi-reference' }, '22': { name: 'Lookup multiple choice', jsm: 'reference' },
  '23': { name: 'HTML', jsm: 'paragraph' }, '24': { name: 'Container split', jsm: 'layout' }, '25': { name: 'Masked', jsm: 'text' },
  '26': { name: 'Email', jsm: 'email' }, '27': { name: 'URL', jsm: 'url' }, '28': { name: 'IP address', jsm: 'text' },
  '29': { name: 'Duration', jsm: 'text' }, '31': { name: 'Requested for', jsm: 'user' }, '32': { name: 'Rich text label', jsm: 'layout' },
  '33': { name: 'Attachment', jsm: 'attachment' }, '30': { name: 'Multi-row variable set', jsm: 'unsupported' },
};

/** Where a reference variable points decides the JSM field: people → user picker, CMDB/assets/models → Assets object. */
export function referenceKind(table: string | undefined): string {
  if (!table) return 'select';
  if (/^(sys_user)$/.test(table)) return 'user';
  if (/^sys_user_group$/.test(table)) return 'team-or-group';
  if (/^(cmdb|alm_|cmn_location|core_company|cmn_department|cmn_cost_center|ast_|service_offering)/.test(table) || /product_model/.test(table)) return 'assets-object';
  return 'select';
}

function itemDraft(r: SnRecord, ctx: ExtractContext, kind: 'catalog-item' | 'record-producer' | 'order-guide'): EvidenceDraft {
  const s = ctx.store;
  const variables = s.childrenOf('item_option_new', 'cat_item', r);
  const setLinks = s.childrenOf('io_set_item', 'sc_cat_item', r);
  const categoryLinks = s.childrenOf('sc_cat_item_category', 'sc_cat_item', r);
  const criteria = [...s.childrenOf('sc_cat_item_user_criteria_mtom', 'sc_cat_item', r), ...s.childrenOf('sc_cat_item_user_criteria_no_mtom', 'sc_cat_item', r)];
  const category = s.ref(r, 'category', ['sc_category']);
  const wf = s.ref(r, 'workflow', ['wf_workflow']);
  const flow = s.ref(r, 'flow_designer_flow', ['sys_hub_flow']);
  const group = s.ref(r, 'group', ['sys_user_group']) ?? s.ref(r, 'fulfillment_group', ['sys_user_group']);
  const requests = s.countFor('usage.req-item-by-cat-item', 'cat_item', r);
  const rels: Relation[] = [
    ...variables.map((v) => ({ type: 'contains' as const, target: v })),
    ...setLinks.map((l) => ({ type: 'uses' as const, target: s.ref(l, 'variable_set', ['item_option_new_set']) })),
    { type: 'references', target: category },
    ...categoryLinks.map((l) => ({ type: 'references' as const, target: s.ref(l, 'sc_category', ['sc_category']) })),
    { type: 'uses', target: wf }, { type: 'uses', target: flow },
    { type: 'assigns-to', target: group },
    ...criteria.map((c) => ({ type: 'references' as const, target: s.ref(c, 'user_criteria', ['user_criteria']) })),
  ];
  const visible = variables.filter((v) => VARIABLE_TYPES[v.fields['type'] ?? '']?.jsm !== 'layout');
  return {
    kind,
    domain: 'ITSM',
    summary: r.fields['short_description'] || undefined,
    usage: requests !== undefined ? { count: requests, periodDays: s.snapshot.usageDays } : undefined,
    attributes: {
      category: s.display(r, 'category') || undefined,
      catalogs: s.display(r, 'sc_catalogs') || undefined,
      price: num(r.fields['price']),
      recurringPrice: num(r.fields['recurring_price']),
      fulfilmentGroup: group ? nameOf(group) : s.display(r, 'group') || undefined,
      workflow: wf ? nameOf(wf) : s.display(r, 'workflow') || undefined,
      flow: flow ? nameOf(flow) : s.display(r, 'flow_designer_flow') || undefined,
      deliveryTime: r.fields['delivery_time'] || undefined,
      variableCount: visible.length,
      mandatoryVariables: visible.filter((v) => isTrue(v.fields['mandatory'])).length,
      variableSets: setLinks.length,
      userCriteria: criteria.length,
      orderGuide: kind === 'order-guide' || undefined,
      targetTable: kind === 'record-producer' ? r.fields['table_name'] || undefined : undefined,
      hasScript: kind === 'record-producer' && Boolean(r.fields['script']?.trim()) ? true : undefined,
      noCart: isTrue(r.fields['no_cart']) || undefined,
    },
    relations: rels,
  };
}

function variableDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft | undefined {
  const t = VARIABLE_TYPES[r.fields['type'] ?? ''] ?? { name: r.fields['type'] || 'unknown', jsm: 'text' };
  if (t.jsm === 'layout') return undefined;
  const s = ctx.store;
  const refTable = r.fields['reference'] || r.fields['list_table'] || r.fields['lookup_table'] || undefined;
  const choices = s.childrenOf('question_choice', 'question', r).map((c) => c.fields['text'] || c.fields['value']).filter(Boolean);
  const item = s.ref(r, 'cat_item', ['sc_cat_item*']);
  const set = s.ref(r, 'variable_set', ['item_option_new_set']);
  const jsm = t.jsm === 'reference' || t.jsm === 'multi-reference' ? referenceKind(refTable) + (t.jsm === 'multi-reference' ? '[]' : '') : t.jsm;
  return {
    kind: 'catalog-variable',
    name: r.fields['question_text'] || r.fields['name'] || r.sysId,
    domain: 'ITSM',
    attributes: {
      variableName: r.fields['name'] || undefined,
      type: t.name,
      jsmFieldKind: jsm,
      mandatory: isTrue(r.fields['mandatory']) || undefined,
      referenceTable: refTable,
      referenceQualifier: r.fields['reference_qual'] || r.fields['reference_qual_condition'] || undefined,
      choices: choices.length ? choices : undefined,
      defaultValue: r.fields['default_value'] || undefined,
      order: num(r.fields['order']),
      item: item ? nameOf(item) : s.display(r, 'cat_item') || undefined,
      variableSet: set ? nameOf(set) : undefined,
    },
    relations: [{ type: 'references', target: item }, { type: 'references', target: set }],
  };
}

function clientScriptDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const a = analyseScript(r.fields['script'], 'client');
  const s = ctx.store;
  const item = s.ref(r, 'cat_item', ['sc_cat_item*']);
  return {
    kind: 'client-script',
    domain: 'ITSM',
    intent: intentOf(a, item ? nameOf(item) : 'catalog form'),
    attributes: {
      scope: 'catalog',
      type: r.fields['type'] || undefined,
      appliesTo: r.fields['applies_to'] || undefined,
      item: item ? nameOf(item) : s.display(r, 'cat_item') || undefined,
      variable: s.display(r, 'cat_variable') || undefined,
      uiType: r.fields['ui_type'] || undefined,
      script: a,
    },
    relations: [{ type: 'references', target: item }, { type: 'references', target: s.ref(r, 'variable_set', ['item_option_new_set']) }],
  };
}

function uiPolicyDraft(r: SnRecord, ctx: ExtractContext, catalog: boolean): EvidenceDraft {
  const s = ctx.store;
  const actions = s.childrenOf(catalog ? 'catalog_ui_policy_action' : 'sys_ui_policy_action', 'ui_policy', r);
  const item = catalog ? s.ref(r, 'catalog_item', ['sc_cat_item*']) : undefined;
  const scripted = isTrue(r.fields['run_scripts']) && Boolean((r.fields['script_true'] ?? '') + (r.fields['script_false'] ?? ''));
  const a = scripted ? analyseScript(`${r.fields['script_true'] ?? ''}\n${r.fields['script_false'] ?? ''}`, 'client') : undefined;
  const act = (f: string) => actions.filter((x) => x.fields[f] === 'true').map((x) => s.display(x, catalog ? 'catalog_variable' : 'field') || x.fields['field'] || x.fields['variable']).filter(Boolean);
  return {
    kind: 'ui-policy',
    domain: catalog ? 'ITSM' : undefined,
    intent: `${act('mandatory').length ? 'makes fields mandatory, ' : ''}${act('visible').length ? 'shows/hides fields, ' : ''}${act('disabled').length ? 'makes fields read-only, ' : ''}`.replace(/, $/, '') || (a ? intentOf(a) : 'conditional form behaviour'),
    attributes: {
      scope: catalog ? 'catalog' : 'form',
      table: r.fields['table'] || undefined,
      item: item ? nameOf(item) : catalog ? s.display(r, 'catalog_item') || undefined : undefined,
      conditions: r.fields['conditions'] || r.fields['catalog_conditions'] || undefined,
      onLoad: isTrue(r.fields['on_load']) || undefined,
      reverseIfFalse: isTrue(r.fields['reverse_if_false']) || undefined,
      actions: actions.length || undefined,
      mandatory: act('mandatory'), visible: act('visible'), readOnly: act('disabled'),
      script: a,
    },
    relations: [{ type: 'references', target: item }],
  };
}

export const catalogExtractors: Extractor[] = [
  { name: 'catalog-item', tables: ['sc_cat_item', 'sc_cat_item_content', 'sc_cat_item_wizard'], consumes: ['io_set_item', 'sc_cat_item_category', 'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom', 'question_choice', 'catalog_ui_policy_action', 'sys_ui_policy_action'], record: (r, c) => itemDraft(r, c, 'catalog-item') },
  { name: 'record-producer', tables: ['sc_cat_item_producer'], record: (r, c) => ({ ...itemDraft(r, c, 'record-producer'), intent: intentOf(analyseScript(r.fields['script'])) }) },
  { name: 'order-guide', tables: ['sc_cat_item_guide'], record: (r, c) => itemDraft(r, c, 'order-guide') },
  {
    name: 'catalog-category', tables: ['sc_category', 'sc_catalog'],
    record: (r, c) => ({
      kind: 'catalog-category', domain: 'ITSM',
      name: r.fields['title'] || r.fields['name'] || r.sysId,
      attributes: { catalog: r.table === 'sc_catalog' || undefined, parent: c.store.display(r, 'parent') || undefined, catalogName: c.store.display(r, 'sc_catalog') || undefined, items: r.table === 'sc_category' ? c.store.childrenOf('sc_cat_item', 'category', r).length || undefined : undefined },
      relations: [{ type: 'references', target: c.store.ref(r, 'parent', ['sc_category']) }],
    }),
  },
  { name: 'catalog-variable', tables: ['item_option_new'], record: variableDraft },
  {
    name: 'variable-set', tables: ['item_option_new_set'],
    record: (r, c) => ({
      kind: 'variable-set', domain: 'ITSM', name: r.fields['title'] || r.fields['name'] || r.sysId,
      attributes: { internalName: r.fields['internal_name'] || undefined, type: r.fields['type'] || undefined, usedBy: c.store.childrenOf('io_set_item', 'variable_set', r).length },
      relations: c.store.childrenOf('item_option_new', 'variable_set', r).map((v) => ({ type: 'contains' as const, target: v })),
    }),
  },
  { name: 'catalog-client-script', tables: ['catalog_script_client'], record: clientScriptDraft },
  { name: 'catalog-ui-policy', tables: ['catalog_ui_policy'], record: (r, c) => uiPolicyDraft(r, c, true) },
  { name: 'ui-policy', tables: ['sys_ui_policy'], record: (r, c) => uiPolicyDraft(r, c, false) },
  {
    name: 'user-criteria', tables: ['user_criteria'],
    record: (r) => ({
      kind: 'user-criteria',
      attributes: {
        users: csv(r.fields['user']).length || undefined, groups: csv(r.fields['group']).length || undefined, roles: csv(r.fields['role']).length || undefined,
        departments: csv(r.fields['department']).length || undefined, locations: csv(r.fields['location']).length || undefined, companies: csv(r.fields['company']).length || undefined,
        matchAll: isTrue(r.fields['match_all']) || undefined, scripted: isTrue(r.fields['advanced']) || undefined,
      },
      intent: 'controls who can see / order catalog items',
    }),
  },
];
