import Resolver from '@forge/resolver';
import type { AsyncEvent } from '@forge/events';
import { platformFor, siteOf } from './forge';
import { Workbench, type Caller, type JobMessage } from './workbench';

type Ctx = { accountId?: string; installContext?: string };

/** Identity and site from the Forge runtime only; nothing the browser sends decides who or where. */
async function callerOf(context: Ctx): Promise<{ caller: Caller; wb: Workbench }> {
  if (!context.accountId) throw new Error('sign in to use the workbench');
  const site = await siteOf(context.installContext);
  const caller: Caller = { ...site, accountId: context.accountId };
  return { caller, wb: new Workbench(platformFor(site, { as: 'user', accountId: caller.accountId })) };
}

type Fn = (wb: Workbench, caller: Caller, payload: unknown) => Promise<unknown>;
const FUNCTIONS: Record<string, Fn> = {
  bootstrap: (wb, c) => wb.bootstrap(c),
  saveSettings: (wb, c, p) => wb.saveSettings(c, p),
  uploadStart: (wb, c, p) => wb.uploadStart(c, p),
  uploadPart: (wb, c, p) => wb.uploadPart(c, p),
  uploadFinish: (wb, c, p) => wb.uploadFinish(c, p),
  summary: (wb, c, p) => wb.summary(c, p),
  setSpace: (wb, c, p) => wb.setSpace(c, p),
  signOffReview: (wb, c, p) => wb.signOffReview(c, p),
  signOff: (wb, c, p) => wb.signOff(c, p),
  startJob: (wb, c, p) => wb.startJob(c, p),
  job: (wb, c, p) => wb.job(c, p),
  manualSteps: (wb, c, p) => wb.manualSteps(c, p),
  confirmManual: (wb, c, p) => wb.confirmManual(c, p),
  report: (wb, c, p) => wb.report(c, p),
  acceptancePlan: (wb, c, p) => wb.acceptancePlan(c, p),
};

const resolver = new Resolver();
for (const [name, fn] of Object.entries(FUNCTIONS)) {
  // Errors are returned, not thrown, so the person sees the gate's message instead of a generic failure.
  resolver.define(name, async (req) => {
    try {
      const { caller, wb } = await callerOf(req.context as Ctx);
      return { ok: true, data: await fn(wb, caller, req.payload) };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      console.error(`workbench ${name} failed: ${message}`);
      return { ok: false, error: message };
    }
  });
}
export const handler = resolver.getDefinitions();

/** Queue consumer for dry-run, verify and apply jobs. Never throws, so the platform never re-runs an apply. */
export async function consumer(event: AsyncEvent<JobMessage>, context: Ctx) {
  try {
    const site = await siteOf(context.installContext);
    const job = await new Workbench(platformFor(site)).runJob(event.body, site, Boolean(event.retryContext));
    console.log(`workbench job ${event.body.jobId}: ${job?.status ?? 'not found'}`);
  } catch (e) {
    console.error(`workbench job ${event.body?.jobId} could not run: ${(e as Error).message}`);
  }
}
