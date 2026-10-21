/**
 * run-qa: the cutoff-minus-2 job. For every live client whose cutoff falls in the window,
 * pull the draft and the prior run, load the signed profile and the ledger, run the 22 checks,
 * persist the run and its exceptions, file the report to Box, and draft the Slack digest.
 *
 * Wire-up is behind the Deps interface so the job is testable without a database.
 * The Vercel cron entrypoint (apps/jobs/api/run-qa.ts) builds Deps from env and calls runQaForWindow.
 */
import { renderReportMarkdown, runChecks, type ChangeRequest, type DraftRun, type PayrollProfile, type RunReport } from "@payroll-qa/engine";
import type { DocumentStore, Notifier, PlatformAdapter } from "@payroll-qa/adapters";
import { exceptionsDigest } from "@payroll-qa/adapters";

export interface ClientDue {
  id: string;
  name: string;
  platform: "gusto" | "rippling";
  platformCompanyId: string;
  boxFolderId?: string;
  specialistSlack: string;
  thresholdOverrides?: Record<string, number>;
}

export interface Deps {
  clientsDue(windowStart: string, windowEnd: string): Promise<ClientDue[]>;
  profileFor(clientId: string): Promise<PayrollProfile | null>;
  ledgerFor(clientId: string): Promise<ChangeRequest[]>;
  adapter(platform: "gusto" | "rippling"): PlatformAdapter;
  persistRun(clientId: string, draft: DraftRun, prior: DraftRun | null, report: RunReport): Promise<string>;
  docs: DocumentStore;
  notifier: Notifier;
  queueLink(runId: string): string;
  now(): string;
}

export interface JobOutcome {
  clientId: string;
  status: "pass" | "exceptions" | "no_profile" | "no_draft" | "error";
  runId?: string;
  counts?: RunReport["counts"];
  error?: string;
}

export async function runQaForWindow(deps: Deps, windowStart: string, windowEnd: string): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (const c of await deps.clientsDue(windowStart, windowEnd)) {
    try {
      const profile = await deps.profileFor(c.id);
      if (!profile?.signedAt) {
        outcomes.push({ clientId: c.id, status: "no_profile" });
        await deps.notifier.draft(c.specialistSlack, `${c.name}: no signed Payroll Profile; QA did not run. Sign the profile or keep the manual process this cycle.`);
        continue;
      }
      const adapter = deps.adapter(c.platform);
      const draft = await adapter.pullDraft(c.platformCompanyId, windowStart);
      if (!draft) {
        outcomes.push({ clientId: c.id, status: "no_draft" });
        await deps.notifier.draft(c.specialistSlack, `${c.name}: no unsubmitted draft found on ${c.platform}; confirm the pay period was created.`);
        continue;
      }
      const prior = await adapter.pullPrior(c.platformCompanyId, draft.period.start);
      const ledger = await deps.ledgerFor(c.id);
      const report = runChecks({ profile, ledger, draft, prior: prior ?? undefined, asOf: deps.now().slice(0, 10), config: c.thresholdOverrides });
      const runId = await deps.persistRun(c.id, draft, prior, report);
      if (c.boxFolderId) {
        const md = renderReportMarkdown(report);
        const stamp = report.period.end;
        await deps.docs.put(c.boxFolderId, `Payroll QA ${stamp}.md`, new TextEncoder().encode(md), "text/markdown");
        await deps.docs.put(c.boxFolderId, `Payroll QA ${stamp}.json`, new TextEncoder().encode(JSON.stringify(report, null, 2)), "application/json");
      }
      if (report.verdict !== "pass") {
        await deps.notifier.draft(c.specialistSlack, exceptionsDigest(c.name, report.period.payDate, report.counts, deps.queueLink(runId)));
      }
      outcomes.push({ clientId: c.id, status: report.verdict, runId, counts: report.counts });
    } catch (err) {
      outcomes.push({ clientId: c.id, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}
