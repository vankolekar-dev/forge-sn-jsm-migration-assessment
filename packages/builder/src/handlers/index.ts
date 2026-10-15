import type { DesignElementType } from '@snjsm/model';
import type { Handler } from '../types';
import { assetsAttribute, assetsObjectType, assetsReferenceType, assetsSchema, assetsStatusType } from './assets';
import { field, space, team, workType, workflow } from './jira';
import { automation, calendar, form, notification, portalGroup, queue, requestType, sla } from './jsm';

/** One handler per design element type. Adding a type to the model without a handler fails the type check. */
export const HANDLERS: { [T in DesignElementType]: Handler<any> } = {
  space, 'work-type': workType, workflow, field, team,
  'portal-group': portalGroup, 'request-type': requestType, form, calendar, sla, queue, notification, automation,
  'assets-schema': assetsSchema, 'assets-status-type': assetsStatusType, 'assets-reference-type': assetsReferenceType,
  'assets-object-type': assetsObjectType, 'assets-attribute': assetsAttribute,
};

export const handlerFor = (t: DesignElementType): Handler => HANDLERS[t];
