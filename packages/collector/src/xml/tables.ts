/**
 * ServiceNow tables the collector understands, used by both the XML parser and the live REST connector.
 * Records from other tables are dropped by the XML parser (and counted in a warning), so anything the analyser
 * reads must be listed here.
 */
export const RECORD_TABLES = new Set<string>([
  // Service catalog
  'sc_cat_item', 'sc_cat_item_producer', 'sc_cat_item_guide', 'sc_cat_item_content', 'sc_cat_item_wizard',
  'item_option_new', 'item_option_new_set', 'io_set_item', 'question_choice', 'sc_category', 'sc_catalog',
  'sc_cat_item_category', 'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom', 'user_criteria',
  'catalog_script_client', 'catalog_ui_policy', 'catalog_ui_policy_action',
  // Flow Designer
  'sys_hub_flow', 'sys_hub_flow_snapshot', 'sys_hub_action_instance', 'sys_hub_action_instance_v2',
  'sys_hub_flow_logic', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance', 'sys_hub_sub_flow_instance_v2',
  'sys_hub_trigger_instance', 'sys_hub_trigger_instance_v2', 'sys_hub_step_instance', 'sys_hub_action_type_definition',
  // Legacy workflow
  'wf_workflow', 'wf_workflow_version', 'wf_activity', 'wf_activity_definition', 'wf_transition', 'wf_condition',
  // Scripts, policies & UI
  'sys_script', 'sys_script_client', 'sys_script_include', 'sys_ui_script', 'sys_ui_policy', 'sys_ui_policy_action', 'sys_ui_action',
  'sys_security_acl', 'sys_security_acl_role', 'sysevent_register', 'sysevent_script_action',
  // Routing, approvals, SLA, notifications
  'sysrule_assignment', 'sysrule_approvals', 'sysapproval_group', 'contract_sla', 'cmn_schedule', 'cmn_schedule_span',
  'sysevent_email_action', 'sysevent_in_email_action', 'sys_email_account', 'dl_definition', 'dl_matcher',
  // Knowledge, portal, virtual agent, reporting
  'kb_knowledge', 'kb_knowledge_base', 'kb_category', 'sp_portal', 'sp_page', 'sp_widget', 'sys_cs_topic',
  'sys_report', 'pa_dashboards', 'pa_indicators', 'sys_portal_page',
  // Data model, users & security
  'sys_db_object', 'sys_dictionary', 'sys_choice', 'sys_user_role', 'sys_user_group', 'sys_group_has_role',
  // CMDB & assets
  'cmdb_ci', 'cmdb_rel_ci', 'cmdb_rel_type', 'cmdb_identifier', 'cmdb_identifier_entry', 'cmdb_model',
  'cmdb_hardware_product_model', 'cmdb_software_product_model', 'cmdb_consumable_product_model',
  'alm_asset', 'alm_hardware', 'alm_license', 'alm_consumable', 'service_offering', 'cmn_location',
  // Integrations & platform
  'sys_rest_message', 'sys_rest_message_fn', 'sys_soap_message', 'sys_soap_message_function', 'sys_ws_definition',
  'sys_ws_operation', 'sys_transform_map', 'sys_transform_entry', 'sys_data_source', 'sysauto_script', 'sysauto',
  'ecc_agent', 'oauth_entity', 'sys_alias', 'sys_app', 'sys_scope', 'sys_store_app', 'sys_plugins', 'v_plugin',
]);

export function isRecordTable(table: string): boolean {
  if (!table) return false;
  if (RECORD_TABLES.has(table)) return true;
  // All CMDB CI subclasses (cmdb_ci_server, cmdb_ci_appl, …) and asset subclasses.
  return table.startsWith('cmdb_ci_') || table.startsWith('alm_');
}
