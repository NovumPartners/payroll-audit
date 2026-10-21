/**
 * The morning after submission: pull the processed register, compare it to the
 * approved draft, record the comparison, and open a post-submit exception per
 * difference. Runs once per submitted run.
 */
import { compareRegisters } from "./diff.js";
import type { Deps } from "./deps.js";

export async function postSubmitCompare(deps: Deps): Promise<{ runId: string; differences?: number; skipped?: string }[]> {
  const now = deps.now();
  const out: { runId: string; differences?: number; skipped?: string }[] = [];
  const clients = new Map((await deps.listLiveClients()).map((c) => [c.id, c]));
  for (const run of await deps.runsAwaitingComparison(new Date(now.getTime() - 6 * 36e5))) {
    const c = clients.get(run.clientId);
    if (!c || !run.platformPayrollId || !run.draftSnapshot) {
      out.push({ runId: run.id, skipped: "no client, payroll id, or approved snapshot" });
      continue;
    }
    const adapter = deps.adapter(c.platform);
    if (!adapter.pullProcessed) {
      out.push({ runId: run.id, skipped: `${c.platform} exports carry no processed register` });
      continue;
    }
    const submitted = await adapter.pullProcessed(c.platformCompanyId, run.platformPayrollId);
    if (!submitted) {
      out.push({ runId: run.id, skipped: "not processed yet" });
      continue;
    }
    const profile = await deps.profileFor(c.id);
    const diffs = compareRegisters(run.draftSnapshot, submitted, profile ?? undefined);
    await deps.recordSubmittedComparison({ runId: run.id, submitted, diffs, at: now });
    if (diffs.length) {
      await deps.notify({ clientId: c.id, runId: run.id, audience: "specialist", recipient: c.specialistSlack ?? "", kind: "post_submit", text: `${c.name}: the submitted register differs from the approved draft in ${diffs.length} place${diffs.length === 1 ? "" : "s"}. ${deps.queueLink(run.id)}` });
    }
    out.push({ runId: run.id, differences: diffs.length });
  }
  return out;
}
