/** Production wiring for the jobs: adapters, Box, Slack, PDF, all from the environment. */
import { BoxStore, RipplingCsvAdapter, SlackWebApi, boxCcgTokenProvider, type DocumentStore, type PlatformAdapter } from "@payroll-qa/adapters";
import { listClients } from "@payroll-qa/db";
import { makeDbDeps, type Deps } from "@payroll-qa/jobs";
import { db } from "./db";
import { env } from "./env";
import { renderPdf } from "./pdf";
import { gustoAdapter } from "./gusto-connection";

class NoDocs implements DocumentStore {
  async put(): Promise<string> {
    throw new Error("Box is not configured");
  }
  async list() {
    return [];
  }
  async get(): Promise<Uint8Array> {
    throw new Error("Box is not configured");
  }
}

export function docs(): DocumentStore {
  const cfg = env.box();
  return cfg ? new BoxStore(boxCcgTokenProvider(cfg)) : new NoDocs();
}

export async function buildDeps(): Promise<Deps> {
  const adapters: Partial<Record<"gusto" | "rippling", PlatformAdapter>> = {};
  const g = await gustoAdapter();
  if (g) adapters.gusto = g;
  const store = docs();
  if (store instanceof BoxStore) {
    const rippling = await listClients(db(), { status: "live" });
    adapters.rippling = new RipplingCsvAdapter(
      (folder, path) => store.readTextByPath(folder, path),
      rippling
        .filter((c) => c.platform === "rippling" && c.boxFolderId && c.nextPeriodStart && c.nextPeriodEnd && c.nextPayDate)
        .map((c) => ({
          platformCompanyId: c.platformCompanyId,
          name: c.legalName,
          boxFolderId: c.boxFolderId!,
          payFrequency: c.payFrequency,
          nextPeriod: { start: c.nextPeriodStart!, end: c.nextPeriodEnd!, payDate: c.nextPayDate! },
        })),
    );
  }
  const slackToken = env.slackBotToken();
  return makeDbDeps({
    db: db(),
    adapters,
    docs: store,
    slack: slackToken ? new SlackWebApi(slackToken) : undefined,
    podChannel: env.slackPodChannel(),
    baseUrl: env.baseUrl,
    renderPdf,
  });
}
