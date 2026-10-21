import { describe, expect, it } from "vitest";
import { runQaForWindow, type Deps } from "../src/run-qa.js";
import { base } from "../../../packages/engine/test/fixtures.js";

function deps(overrides: Partial<Deps> = {}): Deps & { drafts: string[]; files: string[] } {
  const fx = base();
  const drafts: string[] = [];
  const files: string[] = [];
  return {
    drafts, files,
    clientsDue: async () => [{ id: "c_grace", name: "Grace Fellowship", platform: "gusto", platformCompanyId: "co", boxFolderId: "box", specialistSlack: "@specialist" }],
    profileFor: async () => fx.profile,
    ledgerFor: async () => fx.ledger,
    adapter: () => ({ platform: "gusto", listCompanies: async () => [], pullDraft: async () => fx.draft, pullPrior: async () => fx.prior ?? null }),
    persistRun: async () => "run_1",
    docs: { put: async (_f, name) => { files.push(name); return "id"; }, list: async () => [], get: async () => new Uint8Array() },
    notifier: { draft: async (_t, text) => { drafts.push(text); } },
    queueLink: (id) => `https://qa.novum/runs/${id}`,
    now: () => "2026-11-18T06:00:00Z",
    ...overrides,
  };
}

describe("run-qa job", () => {
  it("files the report and stays quiet on a pass", async () => {
    const d = deps();
    const out = await runQaForWindow(d, "2026-11-18", "2026-11-20");
    expect(out[0]?.status).toBe("pass");
    expect(d.files).toEqual(["Payroll QA 2026-11-15.md", "Payroll QA 2026-11-15.json"]);
    expect(d.drafts).toEqual([]);
  });

  it("drafts a digest with the queue link on exceptions", async () => {
    const fx = base();
    fx.draft.blockers = [{ code: "bank", message: "Bank unverified" }];
    const d = deps({ adapter: () => ({ platform: "gusto", listCompanies: async () => [], pullDraft: async () => fx.draft, pullPrior: async () => fx.prior ?? null }) });
    const out = await runQaForWindow(d, "2026-11-18", "2026-11-20");
    expect(out[0]?.status).toBe("exceptions");
    expect(d.drafts[0]).toContain("1 block");
    expect(d.drafts[0]).toContain("runs/run_1");
  });

  it("refuses to run without a signed profile", async () => {
    const fx = base();
    fx.profile.signedAt = undefined;
    const d = deps({ profileFor: async () => fx.profile });
    const out = await runQaForWindow(d, "2026-11-18", "2026-11-20");
    expect(out[0]?.status).toBe("no_profile");
    expect(d.drafts[0]).toContain("no signed Payroll Profile");
  });
});
