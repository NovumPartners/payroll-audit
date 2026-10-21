import type { ChangeRequest, DraftRun, Exception, PayrollProfile, RunReport } from "@payroll-qa/engine";
import type { PlatformAdapter } from "@payroll-qa/adapters";
import type { ClientCtx, Deps, Notification, RunCtx } from "../src/deps.js";
import { base } from "../../../packages/engine/test/fixtures.js";

export interface Fake extends Deps {
  notifications: Notification[];
  files: string[];
  events: { runId: string; kind: string; detail?: unknown }[];
  runs: Map<string, RunCtx & { exceptions: Exception[]; decided: Set<number> }>;
  clock: Date;
  draft: DraftRun | null;
  prior: DraftRun | null;
  processed: DraftRun | null;
  ledger: ChangeRequest[];
  profile: PayrollProfile;
  client: ClientCtx;
  pulls: string[];
}

export function fakeDeps(over: Partial<ClientCtx> = {}): Fake {
  const fx = base();
  const notifications: Notification[] = [];
  const files: string[] = [];
  const events: Fake["events"] = [];
  const runs: Fake["runs"] = new Map();
  const pulls: string[] = [];
  const client: ClientCtx = {
    id: "c_grace", name: "Grace Fellowship", platform: "gusto", platformCompanyId: "co", boxFolderId: "box",
    cutoffDaysBeforePayDate: 2, cutoffHourUtc: 22, specialistSlack: "U_SPEC", contactName: "Church Admin", contactEmail: "admin@grace.example",
    profileSignedAt: "2026-10-20T15:00:00Z", ...over,
  };
  const self: Fake = {
    notifications, files, events, runs, pulls,
    clock: new Date("2026-11-16T07:00:00Z"), // cutoff is 2026-11-18T22:00Z for pay date 11-20; this is inside the c-2 window
    draft: fx.draft, prior: fx.prior ?? null, processed: null, ledger: fx.ledger, profile: fx.profile, client,
    listLiveClients: async () => [self.client],
    leadSlack: async () => "U_LEAD",
    podChannel: async () => "C_POD",
    profileFor: async () => self.profile,
    ledgerFor: async () => self.ledger,
    adapter: (): PlatformAdapter => ({
      platform: "gusto",
      listCompanies: async () => [],
      nextPeriod: async () => { pulls.push("nextPeriod"); return self.draft ? { period: self.draft.period, platformPayrollId: self.draft.platformPayrollId } : null; },
      pullDraft: async () => { pulls.push("pullDraft"); return self.draft; },
      pullPrior: async () => { pulls.push("pullPrior"); return self.prior; },
      pullProcessed: async () => { pulls.push("pullProcessed"); return self.processed; },
    }),
    ensureRun: async (a) => {
      const id = `run_${a.period.end}`;
      const existing = runs.get(id);
      if (existing) return existing;
      const r = { id, clientId: a.clientId, period: a.period, cutoffAt: a.cutoffAt, status: "scheduled" as const, qaAttempt: 0, platformPayrollId: a.platformPayrollId, exceptions: [], decided: new Set<number>() };
      runs.set(id, r);
      return r;
    },
    getRun: async (id) => runs.get(id) ?? null,
    persistQaAttempt: async ({ runId, report }) => {
      const r = runs.get(runId)!;
      r.qaAttempt++;
      r.exceptions = report.exceptions;
      r.decided = new Set();
      r.draftSnapshot = self.draft ?? undefined;
      const open = { block: report.counts.block, review: report.counts.review };
      r.status = open.block + open.review === 0 ? "qa_passed" : "qa_exceptions";
      return { attempt: r.qaAttempt, status: r.status, openBlock: open.block, openReview: open.review };
    },
    setRunReportFile: async () => {},
    openCounts: async (runId) => {
      const r = runs.get(runId)!;
      const open = r.exceptions.filter((_, i) => !r.decided.has(i));
      return { block: open.filter((e) => e.severity === "block").length, review: open.filter((e) => e.severity === "review").length, info: open.filter((e) => e.severity === "info").length };
    },
    hasRunEvent: async (runId, kind) => events.some((e) => e.runId === runId && e.kind === kind),
    addRunEvent: async (e) => { events.push({ runId: e.runId, kind: e.kind, detail: e.detail }); },
    markLate: async (runId) => { runs.get(runId)!.status = "late"; },
    runsAwaitingComparison: async (before) => [...runs.values()].filter((r) => r.status === "submitted" && !r.submittedComparedAt && (r.submittedAt?.getTime() ?? Infinity) < before.getTime()),
    recordSubmittedComparison: async ({ runId, diffs, at }) => { const r = runs.get(runId)!; r.submittedComparedAt = at; events.push({ runId, kind: "post_submit_compared", detail: { differences: diffs.length } }); },
    docs: { put: async (_f, name) => { files.push(name); return `id_${name}`; }, list: async () => [], get: async () => new Uint8Array() },
    notify: async (n) => { notifications.push(n); },
    renderPdf: async () => new Uint8Array([37, 80, 68, 70]),
    queueLink: (id) => `https://qa.novum/runs/${id}`,
    now: () => self.clock,
  };
  return self;
}

export type { RunReport };
