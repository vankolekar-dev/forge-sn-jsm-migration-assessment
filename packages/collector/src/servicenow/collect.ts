import type { SnRecord } from '../types';
import type { Aggregate, Snapshot } from '../snapshot';
import { tableStats } from '../snapshot';
import type { ServiceNowClient } from './client';
import { ServiceNowError } from './http';
import { isRecordTable } from '../xml/tables';

/**
 * Live collection plan. Read-only.
 * - Configuration tables are pulled as records (they are the evidence).
 * - CMDB, assets, knowledge articles and transactional tables are NEVER pulled as records: only server-side
 *   counts (population, relationship class-pair matrix, process usage, fill rates). No CI data leaves the instance.
 */
export interface TablePull { table: string; query?: string; fields?: string[]; purpose: string }
export interface AggregateSpec { id: string; table: string; groupBy: string[]; query?: string; purpose: string }

const RECENT = (days: number) => `sys_created_onRELATIVEGE@dayofweek@ago@${days}`;

/** Tables whose dictionary/choices matter for request, incident, change, problem and the CMDB. */
export const PROCESS_TABLES = ['task', 'incident', 'problem', 'change_request', 'change_task', 'sc_request', 'sc_req_item', 'sc_task', 'sysapproval_approver', 'kb_knowledge', 'hr_case', 'sn_customerservice_case', 'facilities_request'];

export const STANDARD_PULLS: TablePull[] = [
  // Catalog
  ...['sc_catalog', 'sc_category', 'sc_cat_item', 'sc_cat_item_producer', 'sc_cat_item_guide', 'sc_cat_item_content', 'sc_cat_item_category', 'item_option_new', 'item_option_new_set', 'io_set_item', 'question_choice', 'catalog_script_client', 'catalog_ui_policy', 'catalog_ui_policy_action', 'user_criteria', 'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom'].map((table) => ({ table, purpose: 'service catalog' })),
  // Process logic
  ...['sys_hub_flow', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_trigger_instance_v2', 'sys_hub_action_type_definition'].map((table) => ({ table, purpose: 'flow designer' })),
  { table: 'wf_workflow', purpose: 'legacy workflow' },
  { table: 'wf_workflow_version', query: 'published=true', purpose: 'legacy workflow' },
  { table: 'wf_activity', query: 'workflow_version.published=true', purpose: 'legacy workflow' },
  ...['sys_script', 'sys_script_client', 'sys_script_include', 'sys_ui_policy', 'sys_ui_policy_action', 'sys_ui_action', 'sysevent_register', 'sysevent_script_action', 'sysauto_script'].map((table) => ({ table, purpose: 'scripts & policies' })),
  // Routing, approvals, service levels, communication
  ...['sysrule_assignment', 'sysrule_approvals', 'contract_sla', 'cmn_schedule', 'cmn_schedule_span', 'sysevent_email_action', 'sysevent_in_email_action', 'sys_email_account', 'dl_definition'].map((table) => ({ table, purpose: 'routing, approvals, SLAs, notifications' })),
  // Security & people model (no user records)
  { table: 'sys_security_acl', purpose: 'access control' },
  { table: 'sys_security_acl_role', purpose: 'access control' },
  { table: 'sys_user_role', purpose: 'roles' },
  { table: 'sys_user_group', query: 'active=true', purpose: 'groups (no members)' },
  { table: 'sys_group_has_role', purpose: 'group roles' },
  // Data model
  { table: 'sys_db_object', fields: ['name', 'label', 'super_class', 'sys_scope', 'is_extendable', 'sys_created_by', 'sys_package'], purpose: 'table hierarchy' },
  { table: 'sys_dictionary', query: `nameIN${PROCESS_TABLES.join(',')}^ORnameSTARTSWITHcmdb^ORnameSTARTSWITHalm_^ORelementSTARTSWITHu_^ORelementSTARTSWITHx_`, purpose: 'fields on process and CMDB tables, plus all customer fields' },
  { table: 'sys_choice', query: `nameIN${PROCESS_TABLES.join(',')}^inactive=false`, purpose: 'choice lists on process tables' },
  // CMDB metadata (not CIs)
  { table: 'cmdb_rel_type', purpose: 'CMDB relationship types' },
  { table: 'cmdb_identifier', purpose: 'CMDB identification rules' },
  { table: 'cmdb_identifier_entry', purpose: 'CMDB identification rules' },
  // Experience & reporting
  ...['sp_portal', 'sp_page', 'sp_widget', 'sys_cs_topic', 'kb_knowledge_base', 'kb_category', 'pa_dashboards', 'pa_indicators'].map((table) => ({ table, purpose: 'portal, virtual agent, knowledge, reporting' })),
  { table: 'sys_report', query: 'is_published=true^ORroles!=NULL^ORuser=NULL', purpose: 'shared reports' },
  // Integrations & platform
  ...['sys_rest_message', 'sys_rest_message_fn', 'sys_soap_message', 'sys_soap_message_function', 'sys_ws_definition', 'sys_ws_operation', 'sys_transform_map', 'sys_data_source', 'ecc_agent', 'oauth_entity', 'sys_alias', 'sys_app', 'sys_store_app'].map((table) => ({ table, purpose: 'integrations & apps' })),
  { table: 'sys_scope', fields: ['name', 'scope', 'version', 'vendor', 'active', 'sys_created_by'], purpose: 'application scopes' },
  { table: 'sys_plugins', query: 'active=active', fields: ['id', 'name', 'version', 'active'], purpose: 'active plugins' },
];

export function standardAggregates(usageDays: number): AggregateSpec[] {
  const recent = RECENT(usageDays);
  return [
    // Usage
    { id: 'usage.req-item-by-cat-item', table: 'sc_req_item', groupBy: ['cat_item'], query: recent, purpose: 'requests per catalog item' },
    { id: 'usage.req-item-by-group', table: 'sc_req_item', groupBy: ['assignment_group'], query: recent, purpose: 'requested items per fulfilment group' },
    { id: 'usage.sc-task-by-group', table: 'sc_task', groupBy: ['assignment_group'], query: recent, purpose: 'catalog tasks per group' },
    { id: 'usage.task-by-class', table: 'task', groupBy: ['sys_class_name'], query: recent, purpose: 'work volume per process' },
    { id: 'usage.incident-by-category', table: 'incident', groupBy: ['category'], query: recent, purpose: 'incidents per category' },
    { id: 'usage.incident-by-group', table: 'incident', groupBy: ['assignment_group'], query: recent, purpose: 'incidents per group' },
    { id: 'usage.incident-by-channel', table: 'incident', groupBy: ['contact_type'], query: recent, purpose: 'incident intake channels' },
    { id: 'usage.change-by-type', table: 'change_request', groupBy: ['type'], query: recent, purpose: 'changes per type' },
    { id: 'usage.approvals', table: 'sysapproval_approver', groupBy: ['source_table', 'state'], query: recent, purpose: 'approval volume' },
    { id: 'usage.task-sla-by-sla', table: 'task_sla', groupBy: ['sla'], query: recent, purpose: 'SLA usage' },
    { id: 'usage.task-sla-breached', table: 'task_sla', groupBy: ['sla'], query: `${recent}^has_breached=true`, purpose: 'SLA breaches' },
    { id: 'usage.flow-runs', table: 'sys_flow_context', groupBy: ['name'], query: recent, purpose: 'flow executions' },
    { id: 'usage.workflow-runs', table: 'wf_context', groupBy: ['workflow'], query: recent, purpose: 'legacy workflow executions' },
    { id: 'usage.kb-articles', table: 'kb_knowledge', groupBy: ['kb_knowledge_base', 'workflow_state'], purpose: 'articles per knowledge base' },
    { id: 'usage.users', table: 'sys_user', groupBy: ['active'], purpose: 'user population' },
    { id: 'usage.group-members', table: 'sys_user_grmember', groupBy: ['group'], purpose: 'members per group' },
    // CMDB (metadata + counts only)
    { id: 'cmdb.ci-by-class', table: 'cmdb_ci', groupBy: ['sys_class_name'], purpose: 'CI population per class' },
    { id: 'cmdb.ci-by-class-status', table: 'cmdb_ci', groupBy: ['sys_class_name', 'operational_status'], purpose: 'CI operational status per class' },
    { id: 'cmdb.ci-stale', table: 'cmdb_ci', groupBy: ['sys_class_name'], query: 'sys_updated_onRELATIVELT@dayofweek@ago@365', purpose: 'CIs not updated for a year' },
    { id: 'cmdb.ci-by-discovery', table: 'cmdb_ci', groupBy: ['discovery_source'], purpose: 'how CIs get into the CMDB' },
    { id: 'cmdb.rel-matrix', table: 'cmdb_rel_ci', groupBy: ['parent.sys_class_name', 'type', 'child.sys_class_name'], purpose: 'relationship class-pair matrix' },
    { id: 'cmdb.task-ci-usage', table: 'task', groupBy: ['sys_class_name', 'cmdb_ci.sys_class_name'], query: `${recent}^cmdb_ciISNOTEMPTY`, purpose: 'which CI classes processes use' },
    { id: 'cmdb.affected-ci-usage', table: 'task_ci', groupBy: ['task.sys_class_name', 'ci_item.sys_class_name'], query: recent, purpose: 'affected CIs per process' },
    { id: 'cmdb.services', table: 'cmdb_ci_service', groupBy: ['sys_class_name', 'service_classification'], purpose: 'services by CSDM class' },
    { id: 'cmdb.service-offerings', table: 'service_offering', groupBy: ['parent.sys_class_name'], purpose: 'service offerings' },
    { id: 'assets.by-class', table: 'alm_asset', groupBy: ['sys_class_name', 'install_status'], purpose: 'assets per class and state' },
    { id: 'assets.models', table: 'cmdb_model', groupBy: ['sys_class_name'], purpose: 'product models per class' },
    { id: 'locations', table: 'cmn_location', groupBy: ['cmn_location_type'], purpose: 'location hierarchy' },
  ];
}

/** Attributes whose fill rate matters for every CI class (on top of each class's own fields). */
export const KEY_CI_ATTRIBUTES = ['name', 'serial_number', 'asset_tag', 'model_id', 'manufacturer', 'location', 'assigned_to', 'owned_by', 'managed_by', 'support_group', 'operational_status', 'install_status', 'ip_address', 'fqdn', 'os', 'environment'];

export interface CollectOptions {
  usageDays?: number;
  pulls?: TablePull[];
  aggregates?: AggregateSpec[];
  /** Cap per table (safety on huge instances). */
  maxRecordsPerTable?: number;
  /** Fill-rate sampling: top N populated classes × M attributes (each one stats call). 0 disables. */
  fillRate?: { maxClasses: number; maxAttributesPerClass: number };
  onProgress?: (msg: string) => void;
}

export async function collectLive(client: ServiceNowClient, opts: CollectOptions = {}): Promise<Snapshot> {
  const usageDays = opts.usageDays ?? 365;
  const log = opts.onProgress ?? (() => {});
  const max = opts.maxRecordsPerTable ?? 20000;
  const warnings: string[] = [];
  const records: SnRecord[] = [];
  const info = await client.instanceInfo().catch(() => ({} as { build?: string; war?: string }));

  for (const p of opts.pulls ?? STANDARD_PULLS) {
    let n = 0;
    try {
      for await (const page of client.iterateTable(p.table, { query: p.query, fields: p.fields, displayValue: true, limit: max })) {
        // Rows carry sys_class_name; keep it when the collector models that class, otherwise use the pulled table.
        for (const r of page.records) records.push(isRecordTable(r.table) ? r : { ...r, table: p.table });
        n = page.fetched;
      }
      if (n >= max) warnings.push(`${p.table}: stopped at ${max} records (raise maxRecordsPerTable to read more).`);
      log(`${p.table}: ${n}`);
    } catch (e) {
      const msg = e instanceof ServiceNowError && e.status === 400 ? `${p.table}: not available on this instance` : `${p.table}: ${(e as Error).message}`;
      warnings.push(msg);
      log(msg);
    }
  }

  const aggregates: Aggregate[] = [];
  for (const a of opts.aggregates ?? standardAggregates(usageDays)) {
    try {
      aggregates.push({ ...a, rows: await client.countBy(a.table, a.groupBy, a.query) });
      log(`aggregate ${a.id}`);
    } catch (e) {
      aggregates.push({ ...a, rows: [], error: (e as Error).message.slice(0, 200) });
      warnings.push(`aggregate ${a.id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // Fill rates: count non-empty values per attribute on the most populated classes.
  const fr = opts.fillRate ?? { maxClasses: 15, maxAttributesPerClass: 25 };
  const pop = aggregates.find((a) => a.id === 'cmdb.ci-by-class')?.rows ?? [];
  if (fr.maxClasses > 0 && pop.length) {
    const dict = records.filter((r) => r.table === 'sys_dictionary');
    const classes = [...pop].sort((a, b) => b.count - a.count).slice(0, fr.maxClasses);
    for (const c of classes) {
      const cls = c.group['sys_class_name'];
      if (!cls || c.count === 0) continue;
      const own = dict.filter((d) => d.fields['name'] === cls && d.fields['element'] && d.fields['internal_type'] !== 'collection').map((d) => d.fields['element']!);
      const attrs = [...new Set([...KEY_CI_ATTRIBUTES, ...own])].slice(0, fr.maxAttributesPerClass);
      const rows = [];
      for (const attr of attrs) {
        try { rows.push({ group: { attribute: attr }, count: await client.count(cls, `${attr}ISNOTEMPTY`) }); } catch { /* attribute not on this class */ }
      }
      aggregates.push({ id: `cmdb.fill.${cls}`, table: cls, groupBy: ['attribute'], purpose: `fill rate per attribute (of ${c.count})`, rows: [{ group: { attribute: '__total' }, count: c.count }, ...rows] });
      log(`fill rate ${cls}: ${rows.length} attributes`);
    }
  }

  return {
    source: { kind: 'servicenow-live', name: client.instanceUrl.replace(/^https:\/\//, ''), instance: client.instanceUrl.replace(/^https:\/\//, ''), release: info.build, capturedAt: new Date().toISOString() },
    records,
    aggregates,
    warnings,
    stats: tableStats(records),
    usageDays,
  };
}
