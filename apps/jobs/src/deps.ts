/**
 * What the jobs need from the rest of the system, behind one interface so
 * every job is testable without a database, a platform, Box or Slack.
 * `deps-db.ts` builds the production implementation.
 */
import type { ChangeRequest, DraftRun, Exception, PayrollProfile, RunReport } from "@payroll-qa/engine";
import type { DocumentStore, PlatformAdapter } from "@payroll-qa/adapters";

export interface ClientCtx {
  id: string;
  name: string;
  platform: "gusto" | "rippling";
  platformCompanyId: string;
  boxFolderId?: string;
  cutoffDaysBeforePayDate: number;
  cutoffHourUtc: number;
  specialistId?: string;
  specialistSlack?: string; // Slack user id or handle
  contactName?: string;
  contactEmail?: string;
  thresholdOverrides?: Record<string, number | string>;
  profileSignedAt?: string;
}

export interface RunCtx {
  id: string;
  clientId: string;
  period: DraftRun["period"];
  cutoffAt: Date;
  status: "scheduled" | "draft_pulled" | "qa_passed" | "qa_exceptions" | "client_approved" | "submitted" | "late";
  qaAttempt: number;
  platformPayrollId?: string;
  submittedAt?: Date;
  submittedComparedAt?: Date;
  draftSnapshot?: DraftRun;
  qaReport?: RunReport;
}

export interface Notification {
  clientId?: string;
  runId?: string;
  audience: "specialist" | "lead" | "pod" | "client_contact_via_specialist";
  recipient: string;
  kind: string;
  text: string;
}

export interface Deps {
  listLiveClients(): Promise<ClientCtx[]>;
  leadSlack(): Promise<string | undefined>;
  podChannel(): Promise<string | undefined>;
  profileFor(clientId: string): Promise<PayrollProfile | null>;
  ledgerFor(clientId: string): Promise<ChangeRequest[]>;
  adapter(platform: "gusto" | "rippling"): PlatformAdapter;
  ensureRun(args: { clientId: string; period: DraftRun["period"]; cutoffAt: Date; platformPayrollId?: string }): Promise<RunCtx>;
  getRun(runId: string): Promise<RunCtx | null>;
  persistQaAttempt(args: { runId: string; draft: DraftRun; prior: DraftRun | null; report: RunReport; at: Date }): Promise<{ attempt: number; status: string; openBlock: number; openReview: number }>;
  setRunReportFile(runId: string, boxFileId: string): Promise<void>;
  openCounts(runId: string): Promise<{ block: number; review: number; info: number }>;
  hasRunEvent(runId: string, kind: string): Promise<boolean>;
  addRunEvent(args: { runId: string; kind: string; detail?: unknown; at: Date }): Promise<void>;
  markLate(runId: string, at: Date): Promise<void>;
  runsAwaitingComparison(before: Date): Promise<RunCtx[]>;
  recordSubmittedComparison(args: { runId: string; submitted: DraftRun; diffs: Omit<Exception, "severity">[]; at: Date }): Promise<void>;
  docs: DocumentStore;
  /** Record and deliver. Delivery failures are recorded, never thrown into the cycle. */
  notify(n: Notification): Promise<void>;
  renderPdf?(markdown: string, title: string): Promise<Uint8Array>;
  queueLink(runId: string): string;
  now(): Date;
}
