/** The exact phrases a person types at each gate. The service refuses anything else. */
export const confirmPhrase = (planHash: string, site: string) => `APPLY ${planHash} TO ${site}`;
export const testPhrase = (runHash: string, site: string) => `TEST ${runHash} ON ${site}`;
export const cleanupPhrase = (runId: string, site: string) => `CLEANUP ${runId} ON ${site}`;
export const signOffPhrase = (signHash: string, blueprintId: string) => `SIGN OFF ${signHash} FOR ${blueprintId}`;
