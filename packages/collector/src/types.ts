/** A raw ServiceNow record: table, sys_id and string field values (display values stored as `<field>__display`). */
export interface SnRecord {
  table: string;
  sysId: string;
  fields: Record<string, string>;
}
