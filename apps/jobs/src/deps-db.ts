/**
 * Production Deps over the repository, the platform adapters, Box and Slack.
 * Every notification is recorded first; delivery failure is recorded on the
 * row and never stops the cycle.
 */
import type { DocumentStore, Notifier, PlatformAdapter } from "@payroll-qa/adapters";
import type { DraftRun, RunReport } from "@payroll-qa/engine";
import * as repo from "@payroll-qa/db";
import type { AnyDb } from "@payroll-qa/db";
import type { ClientCtx, Deps, Notification, RunCtx } from "./deps";

export interface DbDepsOptions {
  db: AnyDb;
  adapters: Partial<Record<"gusto" | "rippling", PlatformAdapter>>;
  docs: DocumentStore;
  /** Slack delivery for Novum recipients; absent, messages are recorded only (the dashboard inbox shows them). */
  slack?: Notifier;
  podChannel?: string;
  baseUrl: string;
  renderPdf?: (markdown: string, title: string) => Promise<Uint8Array>;
  now?: () => Date;
}

function toRunCtx(r: repo.RunRow): RunCtx {
  return {
    id: r.id,
    clientId: r.clientId,
    period: { start: r.periodStart, end: r.periodEnd, payDate: r.payDate },
    cutoffAt: r.cutoffAt,
    status: r.status,
    qaAttempt: r.qaAttempt,
    platformPayrollId: r.platformPayrollId ?? undefined,
    submittedAt: r.submittedAt ?? undefined,
    submittedComparedAt: r.submittedComparedAt ?? undefined,
    draftSnapshot: (r.draftSnapshot as DraftRun | null) ?? undefined,
    qaReport: (r.qaReport as RunReport | null) ?? undefined,
  };
}

export function makeDbDeps(o: DbDepsOptions): Deps {
  const now = o.now ?? (() => new Date());
  const db = o.db;
  return {
    async listLiveClients(): Promise<ClientCtx[]> {
      const rows = await repo.listLiveClientsWithSpecialist(db);
      return rows.map(({ client: c, specialistSlack }) => ({
        id: c.id,
        name: c.legalName,
        platform: c.platform,
        platformCompanyId: c.platformCompanyId,
        boxFolderId: c.boxFolderId ?? undefined,
        cutoffDaysBeforePayDate: c.cutoffDaysBeforePayDate,
        cutoffHourUtc: c.cutoffHourUtc,
        specialistId: c.specialistId ?? undefined,
        specialistSlack: specialistSlack ?? undefined,
        contactName: c.contactName ?? undefined,
        contactEmail: c.contactEmail ?? undefined,
        thresholdOverrides: c.thresholdOverrides ?? undefined,
        profileSignedAt: c.profileSignedAt?.toISOString(),
      }));
    },
    leadSlack: () => repo.leadSlackId(db),
    podChannel: async () => o.podChannel,
    profileFor: (clientId) => repo.loadProfile(db, clientId),
    ledgerFor: (clientId) => repo.loadLedger(db, clientId),
    adapter(platform) {
      const a = o.adapters[platform];
      if (!a) throw new Error(`No ${platform} adapter configured`);
      return a;
    },
    ensureRun: async (args) => toRunCtx(await repo.ensureRun(db, args)),
    getRun: async (runId) => {
      const r = await repo.getRun(db, runId);
      return r ? toRunCtx(r) : null;
    },
    persistQaAttempt: (args) => repo.persistQaAttempt(db, args),
    setRunReportFile: (runId, fileId) => repo.setRunReportFile(db, runId, fileId),
    openCounts: (runId) => repo.openCounts(db, runId),
    hasRunEvent: (runId, kind) => repo.hasRunEvent(db, runId, kind),
    addRunEvent: (args) => repo.addRunEvent(db, args),
    markLate: (runId, at) => repo.markLate(db, runId, at),
    runsAwaitingComparison: async (before) => (await repo.runsAwaitingComparison(db, before)).map(toRunCtx),
    recordSubmittedComparison: (args) => repo.recordSubmittedComparison(db, args),
    docs: o.docs,
    async notify(n: Notification) {
      const row = await repo.recordNotification(db, n);
      if (!o.slack) return;
      const target = n.audience === "pod" ? o.podChannel : n.recipient || o.podChannel;
      if (!target) {
        await repo.markNotification(db, row.id, { error: "no Slack recipient configured" });
        return;
      }
      try {
        await o.slack.draft(target, n.text);
        await repo.markNotification(db, row.id, { deliveredAt: now() });
      } catch (err) {
        await repo.markNotification(db, row.id, { error: err instanceof Error ? err.message : String(err) });
      }
    },
    renderPdf: o.renderPdf,
    queueLink: (runId) => `${o.baseUrl.replace(/\/$/, "")}/runs/${runId}`,
    now,
  };
}
