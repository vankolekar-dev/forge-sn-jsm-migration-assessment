import type { SnRecord } from '@snjsm/collector';
import { analyseScript, intentOf, scriptRisk, type ScriptAnalysis } from '../script';
import { isTrue, nameOf } from '../store';
import { domainOf, num, queryFields, type EvidenceDraft, type ExtractContext, type Extractor, type Relation } from './common';

/** What a flow step / workflow activity does, from its action or activity definition name. */
export type StepKind = 'approval' | 'task' | 'notification' | 'update' | 'create' | 'wait' | 'lookup' | 'integration' | 'script' | 'assign' | 'logic' | 'subflow' | 'sla' | 'other';

export function stepKind(name: string): StepKind {
  const n = name.toLowerCase();
  if (/approv/.test(n)) return 'approval';
  if (/sub ?flow/.test(n)) return 'subflow';
  if (/(catalog )?task|create task|sc_task/.test(n) && /create|task/.test(n) && !/update/.test(n)) return 'task';
  if (/send (email|notification|sms)|notify|notification|email/.test(n)) return 'notification';
  if (/assign/.test(n)) return 'assign';
  if (/\b(rest|soap|http|spoke|teams|slack|jira|workday|azure|aws|okta|ldap|active directory|sap|salesforce|integrationhub|powershell|ssh)\b/.test(n)) return 'integration';
  if (/wait|timer|pause/.test(n)) return 'wait';
  if (/look ?up|get .*record/.test(n)) return 'lookup';
  if (/update|set values|set field/.test(n)) return 'update';
  if (/create|insert/.test(n)) return 'create';
  if (/sla/.test(n)) return 'sla';
  if (/script|run script/.test(n)) return 'script';
  if (/^(if|else|for each|do the following|parallel|decision|branch|end|start|join|switch|condition|try)\b|if$|join|rollback|turnstile/.test(n)) return 'logic';
  return 'other';
}

/** Script references → relations (resolved by name against the snapshot). */
export function scriptRelations(a: ScriptAnalysis | undefined, ctx: ExtractContext): Relation[] {
  if (!a) return [];
  const s = ctx.store;
  const byName = (table: string, name: string) => s.table(table).find((r) => nameOf(r) === name || r.fields['api_name']?.endsWith(`.${name}`) || r.fields['event_name'] === name);
  return [
    ...a.scriptIncludes.map((n) => ({ type: 'uses' as const, target: byName('sys_script_include', n) })),
    ...a.ajax.map((n) => ({ type: 'uses' as const, target: byName('sys_script_include', n) })),
    ...a.events.map((n) => ({ type: 'triggers' as const, target: byName('sysevent_register', n) })),
    ...a.restMessages.map((m) => ({ type: 'uses' as const, target: byName('sys_rest_message', m.name) })),
    ...a.soapMessages.map((n) => ({ type: 'uses' as const, target: byName('sys_soap_message', n) })),
  ];
}

function scripted(r: SnRecord, ctx: ExtractContext, field: string, context: 'server' | 'client' | 'acl', subject?: string) {
  const a = analyseScript(r.fields[field], context);
  return { a, intent: intentOf(a, subject), risk: scriptRisk(a), relations: scriptRelations(a, ctx) };
}

function flowDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const s = ctx.store;
  const pick = (tables: string[]) => tables.flatMap((t) => s.childrenOf(t, 'flow', r));
  const actions = pick(['sys_hub_action_instance_v2', 'sys_hub_action_instance']);
  const logic = pick(['sys_hub_flow_logic_instance_v2', 'sys_hub_flow_logic']);
  const subflows = pick(['sys_hub_sub_flow_instance_v2', 'sys_hub_sub_flow_instance']);
  const triggers = pick(['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance']);
  const steps = [
    ...actions.map((x) => ({ order: num(x.fields['order']) ?? 0, name: s.display(x, 'action_type') || x.fields['name'] || 'action', source: 'action' })),
    ...logic.map((x) => ({ order: num(x.fields['order']) ?? 0, name: s.display(x, 'logic_definition') || x.fields['name'] || 'logic', source: 'logic' })),
    ...subflows.map((x) => ({ order: num(x.fields['order']) ?? 0, name: s.display(x, 'subflow') || 'subflow', source: 'subflow' })),
  ].sort((a, b) => a.order - b.order).map((x) => ({ ...x, kind: x.source === 'subflow' ? 'subflow' as StepKind : stepKind(x.name) }));
  const trigger = triggers[0] ? s.display(triggers[0], 'trigger_type') || s.display(triggers[0], 'trigger_definition') || triggers[0].fields['name'] : undefined;
  const table = triggers[0]?.fields['table'] || r.fields['table'] || undefined;
  const kinds = [...new Set(steps.map((x) => x.kind))].filter((k) => k !== 'logic' && k !== 'other');
  const type = r.fields['type'] || 'flow';
  return {
    kind: type === 'subflow' ? 'subflow' : 'flow',
    domain: domainOf(table),
    intent: kinds.length ? `Flow that ${kinds.map((k) => ({ approval: 'requests approval', task: 'creates fulfilment tasks', notification: 'notifies people', update: 'updates records', create: 'creates records', wait: 'waits for conditions', lookup: 'looks up records', integration: 'calls external systems', script: 'runs scripts', assign: 'assigns work', subflow: 'calls subflows', sla: 'manages SLAs' } as Record<string, string>)[k] ?? k).join(', ')}` : undefined,
    usage: { count: s.countFor('usage.flow-runs', 'name', r), periodDays: s.snapshot.usageDays },
    attributes: {
      type, status: r.fields['status'] || undefined, runAs: r.fields['run_as'] || undefined, trigger, table,
      steps: steps.length ? steps.map(({ order, name, kind }) => ({ order, name, kind })) : undefined,
      stepKinds: kinds, stepCount: steps.length || undefined,
      approvals: steps.filter((x) => x.kind === 'approval').length || undefined,
      integrations: steps.filter((x) => x.kind === 'integration').map((x) => x.name),
      customActions: steps.filter((x) => x.kind === 'other').map((x) => x.name),
    },
    relations: subflows.map((x) => ({ type: 'uses' as const, target: s.ref(x, 'subflow', ['sys_hub_flow']) })),
  };
}

function workflowDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const s = ctx.store;
  const versions = s.childrenOf('wf_workflow_version', 'workflow', r);
  const acts = [...s.childrenOf('wf_activity', 'workflow_version', r), ...versions.flatMap((v) => s.childrenOf('wf_activity', 'workflow_version', v))];
  const steps = [...new Set(acts)].map((x) => {
    const def = s.display(x, 'activity_definition') || x.fields['type'] || '';
    const name = x.fields['name'] || def;
    const a = analyseScript(x.fields['script'] || x.fields['vars'], 'server');
    return { order: num(x.fields['order']) ?? 0, name, definition: def || undefined, kind: stepKind(`${def} ${name}`), script: a ? { lines: a.lines, patterns: a.patterns } : undefined };
  }).sort((a, b) => a.order - b.order);
  const kinds = [...new Set(steps.map((x) => x.kind))].filter((k) => k !== 'logic' && k !== 'other');
  const table = r.fields['table'] || versions[0]?.fields['table'] || undefined;
  return {
    kind: 'legacy-workflow',
    domain: domainOf(table),
    intent: kinds.length ? `Legacy workflow: ${kinds.join(', ')}` : r.fields['description'] || undefined,
    usage: { count: s.countFor('usage.workflow-runs', 'workflow', r), periodDays: s.snapshot.usageDays },
    attributes: {
      table, activities: steps.length || undefined, stepKinds: kinds,
      steps: steps.length ? steps.map(({ order, name, kind, definition }) => ({ order, name, kind, definition })) : undefined,
      approvals: steps.filter((x) => x.kind === 'approval').length || undefined,
      scriptedActivities: steps.filter((x) => x.script).length || undefined,
      published: versions.some((v) => isTrue(v.fields['published'])) || undefined,
    },
  };
}

function businessRuleDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const table = r.fields['collection'] || r.fields['table'] || '';
  const sc = scripted(r, ctx, 'script', 'server', table);
  const ops = ['insert', 'update', 'delete', 'query'].filter((o) => isTrue(r.fields[`action_${o}`]) || (r.fields['action'] ?? '').includes(o));
  const cond = r.fields['filter_condition'] || r.fields['condition'] || undefined;
  const conditionOnly = !sc.a && Boolean(r.fields['set_field_value'] || r.fields['template']);
  return {
    kind: 'business-rule',
    domain: domainOf(table),
    intent: sc.intent ?? (conditionOnly ? `On ${table}: sets field values (no script)` : undefined),
    attributes: {
      table, when: r.fields['when'] || undefined, operations: ops, order: num(r.fields['order']), condition: cond,
      conditionFields: queryFields(r.fields['filter_condition']).map((q) => q.field),
      advanced: isTrue(r.fields['advanced']) || Boolean(sc.a) || undefined,
      setsValues: r.fields['set_field_value'] || undefined,
      abortAction: isTrue(r.fields['abort_action']) || undefined,
      addMessage: isTrue(r.fields['add_message']) || undefined,
      risk: sc.risk, script: sc.a,
    },
    relations: sc.relations,
  };
}

export const processExtractors: Extractor[] = [
  { name: 'flow', tables: ['sys_hub_flow'], consumes: ['sys_hub_action_instance', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance', 'sys_hub_sub_flow_instance_v2', 'sys_hub_trigger_instance', 'sys_hub_trigger_instance_v2', 'sys_hub_step_instance', 'sys_hub_flow_snapshot', 'sys_hub_action_type_definition'], record: flowDraft },
  { name: 'legacy-workflow', tables: ['wf_workflow'], consumes: ['wf_workflow_version', 'wf_activity', 'wf_activity_definition', 'wf_transition', 'wf_condition'], record: workflowDraft },
  { name: 'business-rule', tables: ['sys_script'], record: businessRuleDraft },
  {
    name: 'client-script', tables: ['sys_script_client'],
    record: (r, c) => {
      const table = r.fields['table'] || '';
      const sc = scripted(r, c, 'script', 'client', table);
      return { kind: 'client-script', domain: domainOf(table), intent: sc.intent, attributes: { scope: 'form', table, type: r.fields['type'] || undefined, field: r.fields['field_name'] || undefined, uiType: r.fields['ui_type'] || undefined, isolated: r.fields['isolate_script'] || undefined, risk: sc.risk, script: sc.a }, relations: sc.relations };
    },
  },
  {
    name: 'ui-action', tables: ['sys_ui_action'],
    record: (r, c) => {
      const table = r.fields['table'] || '';
      const client = isTrue(r.fields['client']);
      const sc = scripted(r, c, 'script', client ? 'client' : 'server', table);
      return {
        kind: 'ui-action', domain: domainOf(table), intent: sc.intent,
        attributes: { table, actionName: r.fields['action_name'] || undefined, client: client || undefined, formButton: isTrue(r.fields['form_button']) || undefined, formLink: isTrue(r.fields['form_link']) || undefined, listAction: isTrue(r.fields['list_action']) || isTrue(r.fields['list_button']) || undefined, condition: r.fields['condition'] || undefined, roles: r.fields['roles'] || undefined, risk: sc.risk, script: sc.a },
        relations: sc.relations,
      };
    },
  },
  {
    name: 'script-include', tables: ['sys_script_include'],
    record: (r, c) => {
      const sc = scripted(r, c, 'script', 'server');
      return { kind: 'script-include', intent: sc.intent, attributes: { apiName: r.fields['api_name'] || undefined, clientCallable: isTrue(r.fields['client_callable']) || undefined, access: r.fields['access'] || undefined, risk: sc.risk, script: sc.a }, relations: sc.relations };
    },
  },
  {
    name: 'scheduled-job', tables: ['sysauto_script', 'sysauto'],
    record: (r, c) => {
      const sc = scripted(r, c, 'script', 'server');
      return { kind: 'scheduled-job', intent: sc.intent, attributes: { runType: r.fields['run_type'] || undefined, runPeriod: r.fields['run_period'] || undefined, runTime: r.fields['run_time'] || undefined, runAs: c.store.display(r, 'run_as') || undefined, conditional: isTrue(r.fields['conditional']) || undefined, risk: sc.risk, script: sc.a }, relations: sc.relations };
    },
  },
  {
    name: 'event', tables: ['sysevent_register'],
    record: (r) => ({ kind: 'event', name: r.fields['event_name'] || nameOf(r), domain: domainOf(r.fields['table']), attributes: { table: r.fields['table'] || undefined, firedBy: r.fields['fired_by'] || undefined, queue: r.fields['queue'] || undefined, description: r.fields['description'] || undefined } }),
  },
  {
    name: 'script-action', tables: ['sysevent_script_action'],
    record: (r, c) => {
      const sc = scripted(r, c, 'script', 'server');
      const ev = c.store.table('sysevent_register').find((e) => e.fields['event_name'] === (c.store.display(r, 'event_name') || r.fields['event_name']));
      return { kind: 'business-rule', intent: sc.intent, attributes: { trigger: 'event', event: c.store.display(r, 'event_name') || undefined, risk: sc.risk, script: sc.a }, relations: [{ type: 'triggered-by', target: ev }, ...sc.relations] };
    },
  },
  {
    name: 'transform-map', tables: ['sys_transform_map'], consumes: ['sys_transform_entry'],
    record: (r, c) => {
      const entries = c.store.childrenOf('sys_transform_entry', 'map', r);
      const sc = scripted(r, c, 'script', 'server');
      return {
        kind: 'transform-map', domain: domainOf(r.fields['target_table']),
        intent: `Imports data into ${r.fields['target_table'] || 'a table'}`,
        attributes: { sourceTable: r.fields['source_table'] || undefined, targetTable: r.fields['target_table'] || undefined, fieldMaps: entries.length || undefined, runScript: isTrue(r.fields['run_script']) || undefined, coalesce: entries.filter((e) => isTrue(e.fields['coalesce'])).map((e) => e.fields['target_field']).filter(Boolean), script: sc.a },
        relations: [{ type: 'depends-on', target: c.store.table('sys_data_source').find((d) => d.fields['import_set_table_name'] && d.fields['import_set_table_name'] === r.fields['source_table']) }, ...sc.relations],
      };
    },
  },
  {
    name: 'data-source', tables: ['sys_data_source'],
    record: (r) => ({ kind: 'integration', intent: 'Import source for an import set', attributes: { integrationType: 'import', type: r.fields['type'] || undefined, format: r.fields['format'] || undefined, importSetTable: r.fields['import_set_table_name'] || undefined, fileRetrieval: r.fields['file_retrieval_method'] || undefined, connection: r.fields['jdbc_server'] || r.fields['connection_url'] || undefined } }),
  },
  {
    name: 'decision-table', tables: ['dl_definition'],
    record: (r) => ({ kind: 'other', intent: `Data lookup / decision matrix on ${r.fields['table'] || 'a table'} (e.g. priority from impact × urgency)`, domain: domainOf(r.fields['table']), attributes: { type: 'data-lookup', table: r.fields['table'] || undefined, matcherTable: r.fields['matcher_table'] || undefined } }),
  },
];
