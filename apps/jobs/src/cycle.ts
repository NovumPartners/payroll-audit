/**
 * The cycle tick (hourly). For every live client with a signed profile, find
 * the next pay period, make sure its run exists with the right cutoff, and
 * execute every stage whose window is open and has not run yet:
 *
 *   cutoff - 5 days   remind the specialist of received requests and D2 items
 *   cutoff - 3 days   draft the client reminder (delivered to the specialist to send)
 *   cutoff - 2 days   the QA run
 *   cutoff - 1 day    escalate open blocks to the lead
 *   cutoff - 4 hours  escalate missing client approval to the lead
 *   cutoff            mark the run late if not submitted
 *
 * Every stage is recorded as a run event and never runs twice. Missing a tick
 * loses nothing: a stage still open on the next tick runs then.
 */
import { familyD, runChecks } from "@payroll-qa/engine";
import { missingInputsReminder } from "@payroll-qa/adapters";
import type { ClientCtx, Deps, RunCtx } from "./deps";
import { runQaForClient } from "./run-qa";
import { cutoffFor, isoDate, openStages, type Stage } from "./schedule";

export interface CycleOutcome {
  clientId: string;
  runId?: string;
  stages: Stage[];
  error?: string;
}

export async function runCycle(deps: Deps): Promise<CycleOutcome[]> {
  const out: CycleOutcome[] = [];
  const clients = await deps.listLiveClients();
  for (const c of clients) {
    try {
      out.push(await cycleClient(deps, c));
    } catch (err) {
      out.push({ clientId: c.id, stages: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export async function cycleClient(deps: Deps, c: ClientCtx): Promise<CycleOutcome> {
  const now = deps.now();
  if (!c.profileSignedAt) return { clientId: c.id, stages: [] };
  const next = await deps.adapter(c.platform).nextPeriod(c.platformCompanyId, isoDate(new Date(now.getTime() - 45 * 864e5)));
  if (!next) return { clientId: c.id, stages: [] };
  const cutoffAt = cutoffFor(next.period.payDate, c.cutoffDaysBeforePayDate, c.cutoffHourUtc);
  const run = await deps.ensureRun({ clientId: c.id, period: next.period, cutoffAt, platformPayrollId: next.platformPayrollId });
  if (run.status === "submitted") return { clientId: c.id, runId: run.id, stages: [] };
  const done: Stage[] = [];
  for (const stage of openStages(run.cutoffAt, now)) {
    if (await deps.hasRunEvent(run.id, `stage:${stage}`)) continue;
    const ran = await runStage(deps, c, run, stage);
    if (ran) done.push(stage);
  }
  return { clientId: c.id, runId: run.id, stages: done };
}

async function runStage(deps: Deps, c: ClientCtx, run: RunCtx, stage: Stage): Promise<boolean> {
  const now = deps.now();
  const mark = (detail?: unknown) => deps.addRunEvent({ runId: run.id, kind: `stage:${stage}`, detail, at: now });
  switch (stage) {
    case "remind_specialist": {
      const items = await openItems(deps, c, run);
      if (items.length) {
        await deps.notify({ clientId: c.id, runId: run.id, audience: "specialist", recipient: c.specialistSlack ?? "", kind: "remind_specialist", text: missingInputsReminder(c.name, isoDate(run.cutoffAt), items) });
      }
      await mark({ items: items.length });
      return true;
    }
    case "remind_client": {
      const items = await openItems(deps, c, run, { ledgerOnly: true });
      if (items.length) {
        const to = c.contactName ? `${c.contactName}${c.contactEmail ? ` <${c.contactEmail}>` : ""}` : (c.contactEmail ?? "the client contact");
        const text = `Draft for ${to}, to send today: "Hi ${c.contactName ?? ""}, today is the input deadline for the ${run.period.payDate} payroll. We still need: ${items.join("; ")}. Anything received after today moves to the next run."`;
        await deps.notify({ clientId: c.id, runId: run.id, audience: "client_contact_via_specialist", recipient: c.specialistSlack ?? "", kind: "remind_client", text });
      }
      await mark({ items: items.length });
      return true;
    }
    case "qa": {
      if (run.qaAttempt > 0) {
        await mark({ skipped: "already run on demand" });
        return true;
      }
      const outcome = await runQaForClient(deps, c, run, { trigger: "scheduled" });
      if (outcome.status === "error") return false;
      if (outcome.status === "no_draft" || outcome.status === "no_profile") return false; // try again next tick
      return true; // runQaForClient records stage:qa itself
    }
    case "escalate_blocks": {
      const counts = await deps.openCounts(run.id);
      if (counts.block > 0 || run.qaAttempt === 0) {
        const lead = await deps.leadSlack();
        const why = run.qaAttempt === 0 ? "QA has not run" : `${counts.block} block exception${counts.block === 1 ? "" : "s"} open`;
        await deps.notify({ clientId: c.id, runId: run.id, audience: "lead", recipient: lead ?? "", kind: "escalation_blocks", text: `Escalation: ${c.name} is one day from cutoff (${run.cutoffAt.toISOString()}) with ${why}. Specialist: ${c.specialistSlack ?? "unassigned"}. ${deps.queueLink(run.id)}` });
        await mark({ openBlock: counts.block, escalated: true });
      } else {
        await mark({ openBlock: 0, escalated: false });
      }
      return true;
    }
    case "escalate_no_approval": {
      const fresh = (await deps.getRun(run.id)) ?? run;
      if (fresh.status !== "client_approved" && fresh.status !== "submitted") {
        const lead = await deps.leadSlack();
        await deps.notify({ clientId: c.id, runId: run.id, audience: "lead", recipient: lead ?? "", kind: "escalation_no_approval", text: `Escalation: ${c.name} has no client approval four hours before cutoff (${run.cutoffAt.toISOString()}); status ${fresh.status}. ${deps.queueLink(run.id)}` });
        await mark({ status: fresh.status, escalated: true });
      } else {
        await mark({ status: fresh.status, escalated: false });
      }
      return true;
    }
    case "late": {
      const fresh = (await deps.getRun(run.id)) ?? run;
      if (fresh.status !== "submitted") {
        await deps.markLate(run.id, now);
        const lead = await deps.leadSlack();
        await deps.notify({ clientId: c.id, runId: run.id, audience: "lead", recipient: lead ?? "", kind: "late", text: `${c.name}: cutoff ${run.cutoffAt.toISOString()} passed with status ${fresh.status}; the run is late. ${deps.queueLink(run.id)}` });
      }
      await mark({ status: fresh.status });
      return true;
    }
  }
}

/** Received requests effective by period end, plus D2 items from the profile calendar (no draft needed for those). */
async function openItems(deps: Deps, c: ClientCtx, run: RunCtx, opts: { ledgerOnly?: boolean } = {}): Promise<string[]> {
  const [profile, ledger] = await Promise.all([deps.profileFor(c.id), deps.ledgerFor(c.id)]);
  const items: string[] = [];
  for (const r of ledger) {
    if (r.status === "received" && r.effectiveDate <= run.period.end) {
      const who = r.employeeId ? profile?.employees.find((e) => e.id === r.employeeId)?.name : undefined;
      items.push(`${r.type.replace(/_/g, " ")} effective ${r.effectiveDate}${who ? ` for ${who}` : ""} received ${r.submittedAt.slice(0, 10)} and not yet applied`);
    }
  }
  if (!opts.ledgerOnly && profile) {
    const stub = { clientId: c.id, platform: c.platform, platformPayrollId: run.platformPayrollId ?? "", period: run.period, payFrequency: profile.payFrequency, employees: [], blockers: [], pulledAt: deps.now().toISOString() };
    const d2 = familyD.find((ch) => ch.code === "D2")!;
    const report = runChecks({ profile, ledger, draft: stub, asOf: isoDate(deps.now()) }, [d2]);
    for (const e of report.exceptions) items.push(`${e.employeeName ?? c.name}: ${e.expected}`);
  }
  return items;
}
