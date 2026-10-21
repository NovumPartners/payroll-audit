/**
 * Adapter contracts. Every platform adapter produces the engine's normalized DraftRun.
 * The engine never imports from a platform module.
 */
import type { DraftRun, ChangeRequest } from "@payroll-qa/engine";

export interface PlatformAdapter {
  platform: "gusto" | "rippling";
  /** List client companies this credential administers. */
  listCompanies(): Promise<{ platformCompanyId: string; name: string }[]>;
  /** The next unsubmitted pay period on or after `onOrAfter`, without pulling the whole draft (one list call). */
  nextPeriod(platformCompanyId: string, onOrAfter: string): Promise<{ period: DraftRun["period"]; platformPayrollId: string } | null>;
  /** Pull the unsubmitted draft for the period that contains `onOrAfter`, normalized. */
  pullDraft(platformCompanyId: string, onOrAfter: string): Promise<DraftRun | null>;
  /** Pull the most recent submitted (processed) run before `before`, normalized. */
  pullPrior(platformCompanyId: string, before: string): Promise<DraftRun | null>;
  /** Pull a specific processed run (the post-submit comparison); null until processed. Optional for export-mode platforms. */
  pullProcessed?(platformCompanyId: string, platformPayrollId: string): Promise<DraftRun | null>;
}

export interface DocumentStore {
  /** Write a file into the client folder; returns the file id. */
  put(clientFolderId: string, name: string, bytes: Uint8Array, mime: string): Promise<string>;
  /** List and read source documents for the profile builder. */
  list(clientFolderId: string): Promise<{ id: string; name: string; mime: string; size: number; type?: "file" | "folder" }[]>;
  get(fileId: string): Promise<Uint8Array>;
  /** Text of a file at a relative path under the folder, or null when absent. */
  readTextByPath?(clientFolderId: string, relativePath: string): Promise<string | null>;
}

export interface Notifier {
  /** Drafts only. Nothing sends without a person pressing send. */
  draft(channelOrUser: string, text: string): Promise<void>;
}

export interface WebhookMapper {
  /** Map a raw JotForm submission into a ChangeRequest; throws on unknown form. */
  toChangeRequest(raw: unknown): ChangeRequest;
}

export { GustoAdapter, type GustoAdapterOptions } from "./gusto/index";
export { mapGustoPayroll, classifyEarning, annualizeRate, sumHousing, type GustoContext, type GustoPayroll } from "./gusto/map";
export { RipplingCsvAdapter, parseRipplingRegister, parseCsv, DEFAULT_REGISTER_COLUMNS, DEFAULT_ROSTER_COLUMNS } from "./rippling/index";
export { JotFormMapper, normalizeDate, verifySharedSecret, type JotFormFieldMap, type JotFormRawSubmission } from "./jotform/index";
export { BoxStore, boxCcgTokenProvider, type BoxCcgConfig, type TokenProvider } from "./box/index";
export { SlackDrafts, SlackWebApi, exceptionsDigest, missingInputsReminder } from "./slack/index";
