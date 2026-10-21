/**
 * Adapter contracts. Every platform adapter produces the engine's normalized DraftRun.
 * The engine never imports from a platform module.
 */
import type { DraftRun, ChangeRequest } from "@payroll-qa/engine";

export interface PlatformAdapter {
  platform: "gusto" | "rippling";
  /** List client companies this credential administers. */
  listCompanies(): Promise<{ platformCompanyId: string; name: string }[]>;
  /** Pull the unsubmitted draft for the period that contains `onOrAfter`, normalized. */
  pullDraft(platformCompanyId: string, onOrAfter: string): Promise<DraftRun | null>;
  /** Pull the most recent submitted (processed) run before `before`, normalized. */
  pullPrior(platformCompanyId: string, before: string): Promise<DraftRun | null>;
}

export interface DocumentStore {
  /** Write a file into the client folder; returns the file id. */
  put(clientFolderId: string, name: string, bytes: Uint8Array, mime: string): Promise<string>;
  /** List and read source documents for the profile builder. */
  list(clientFolderId: string): Promise<{ id: string; name: string; mime: string; size: number }[]>;
  get(fileId: string): Promise<Uint8Array>;
}

export interface Notifier {
  /** Drafts only. Nothing sends without a person pressing send. */
  draft(channelOrUser: string, text: string): Promise<void>;
}

export interface WebhookMapper {
  /** Map a raw JotForm submission into a ChangeRequest; throws on unknown form. */
  toChangeRequest(raw: unknown): ChangeRequest;
}

export { GustoAdapter } from "./gusto/index.js";
export { mapGustoPayroll } from "./gusto/map.js";
export { RipplingCsvAdapter, parseRipplingRegister } from "./rippling/index.js";
export { JotFormMapper, type JotFormFieldMap } from "./jotform/index.js";
export { BoxStore } from "./box/index.js";
export { SlackDrafts } from "./slack/index.js";
