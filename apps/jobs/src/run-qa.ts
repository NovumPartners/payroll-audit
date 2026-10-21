/**
 * The QA run for one client's run: pull the draft and the prior, run the 22
 * checks, persist the attempt (snapshots whole), file the report to Box as
 * Markdown, JSON and PDF, and notify the specialist when there are exceptions.
 * Used by the cutoff-minus-2 stage and by the on-demand re-run button.
 */
import { renderReportMarkdown, runChecks } from "@payroll-qa/engine";
import { exceptionsDigest } from "@payroll-qa/adapters";
import type { ClientCtx, Deps, RunCtx } from "./deps.js";

export interface QaOutcome {
  clientId: string;
  runId?: string;
  status: "pass" | "exceptions" | "no_profile" | "no_draft" | "error";
  attempt?: number;
  counts?: { block: number; review: number; info: number };
  error?: string;
}

export async function runQaForClient(deps: Deps, c: ClientCtx, run: RunCtx, opts: { notifyOnPass?: boolean; trigger: "scheduled" | "manual" }): Promise<QaOutcome> {
  const now = deps.now();
  const profile = await deps.profileFor(c.id);
  if (!profile?.signedAt) {
    await deps.notify({ clientId: c.id, runId: run.id, audience: "specialist", recipient: c.specialistSlack ?? "", kind: "no_profile", text: `${c.name}: no signed Payroll Profile; QA did not run. Sign the profile or keep the manual process this cycle.` });
    return { clientId: c.id, runId: run.id, status: "no_profile" };
  }
  const adapter = deps.adapter(c.platform);
  const draft = await adapter.pullDraft(c.platformCompanyId, run.period.start);
  if (!draft || draft.period.end !== run.period.end) {
    await deps.notify({ clientId: c.id, runId: run.id, audience: "specialist", recipient: c.specialistSlack ?? "", kind: "no_draft", text: `${c.name}: no unsubmitted draft for the period ending ${run.period.end} on ${c.platform}; confirm the pay period exists.` });
    return { clientId: c.id, runId: run.id, status: "no_draft" };
  }
  const prior = await adapter.pullPrior(c.platformCompanyId, draft.period.start);
  const ledger = await deps.ledgerFor(c.id);
  const report = runChecks({ profile, ledger, draft, prior: prior ?? undefined, asOf: now.toISOString().slice(0, 10), config: c.thresholdOverrides as never });
  const persisted = await deps.persistQaAttempt({ runId: run.id, draft, prior, report, at: now });
  if (c.boxFolderId) {
    const md = renderReportMarkdown(report);
    const stamp = `${report.period.end} attempt ${persisted.attempt}`;
    const mdId = await deps.docs.put(c.boxFolderId, `Payroll QA ${stamp}.md`, new TextEncoder().encode(md), "text/markdown");
    await deps.docs.put(c.boxFolderId, `Payroll QA ${stamp}.json`, new TextEncoder().encode(JSON.stringify(report, null, 2)), "application/json");
    let fileId = mdId;
    if (deps.renderPdf) {
      const pdf = await deps.renderPdf(md, `Payroll QA ${c.name} ${report.period.end}`);
      fileId = await deps.docs.put(c.boxFolderId, `Payroll QA ${stamp}.pdf`, pdf, "application/pdf");
    }
    await deps.setRunReportFile(run.id, fileId);
  }
  const open = { block: persisted.openBlock, review: persisted.openReview, info: report.counts.info };
  if (open.block + open.review > 0 || opts.notifyOnPass) {
    await deps.notify({ clientId: c.id, runId: run.id, audience: "specialist", recipient: c.specialistSlack ?? "", kind: "qa_digest", text: exceptionsDigest(c.name, report.period.payDate, open, deps.queueLink(run.id)) });
  }
  await deps.addRunEvent({ runId: run.id, kind: opts.trigger === "manual" ? "qa_rerun_requested" : "stage:qa", detail: { attempt: persisted.attempt }, at: now });
  return { clientId: c.id, runId: run.id, status: open.block + open.review === 0 ? "pass" : "exceptions", attempt: persisted.attempt, counts: open };
}
