import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { can, canView } from "../lib/authz";
import { PERSONAL_TENANT, workAccount } from "../lib/identity";
import { parseJotformForms } from "../lib/jotform-config";
import { renderPdf } from "../lib/pdf";
import { makePreviewToken, readPreviewToken } from "../lib/preview-token";
import { signSession, verifySession } from "../lib/session";
import { renderProfileMarkdown } from "../lib/profile-markdown";
import { profile } from "../../../packages/engine/test/fixtures";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("session cookie", () => {
  it("round-trips, expires after 12 hours, and refuses a different secret or a tampered token", async () => {
    const t0 = new Date("2026-11-16T08:00:00Z");
    const token = await signSession({ email: "a@novumsp.com", oid: "oid-1" }, SECRET, t0);
    expect(await verifySession(token, SECRET, t0)).toEqual({ email: "a@novumsp.com", oid: "oid-1" });
    expect(await verifySession(token, SECRET, new Date("2026-11-16T20:00:01Z"))).toBeNull();
    expect(await verifySession(token, "x".repeat(32), t0)).toBeNull();
    expect(await verifySession(token.slice(0, -2) + "zz", SECRET, t0)).toBeNull();
    expect(await verifySession(undefined, SECRET, t0)).toBeNull();
  });
});

describe("work-account rule", () => {
  const tenant = "11111111-2222-3333-4444-555555555555";
  it("admits only tokens issued by Novum's tenant, whatever the email domain", () => {
    expect(workAccount({ tid: tenant, oid: "o", preferred_username: "Brad@NovumSP.com" }, tenant)).toEqual({ email: "brad@novumsp.com", oid: "o", name: undefined });
    expect(workAccount({ tid: tenant, oid: "o", preferred_username: "contractor@gmail.com", name: "C" }, tenant)).toMatchObject({ email: "contractor@gmail.com" }); // the tenant admits them; the access list decides
    expect(workAccount({ tid: PERSONAL_TENANT, oid: "o", preferred_username: "brad@novumsp.com" }, tenant)).toBeNull();
    expect(workAccount({ tid: "other-tenant", oid: "o", preferred_username: "brad@novumsp.com" }, tenant)).toBeNull();
    expect(workAccount({ tid: tenant, oid: "o", preferred_username: "x@novumsp.com", idp: "live.com" }, tenant)).toBeNull();
    expect(workAccount({ tid: tenant, preferred_username: "x@novumsp.com" }, tenant)).toBeNull();
    expect(workAccount({ tid: tenant, oid: "o" }, tenant)).toBeNull();
  });
});

describe("capabilities", () => {
  it("lead does everything, specialist acts on assigned clients only, reviewer reads, nobody submits payroll", () => {
    expect(can({ role: "lead" }, "admin")).toBe(true);
    expect(can({ role: "lead" }, "decide_exception", false)).toBe(true);
    expect(can({ role: "specialist" }, "decide_exception", true)).toBe(true);
    expect(can({ role: "specialist" }, "decide_exception", false)).toBe(false);
    expect(can({ role: "specialist" }, "admin", true)).toBe(false);
    expect(can({ role: "reviewer" }, "decide_exception", true)).toBe(false);
    expect(can({ role: "reviewer" }, "view_all_clients")).toBe(true);
    expect(canView({ role: "specialist" }, false)).toBe(false);
    expect(canView({ role: "reviewer" }, false)).toBe(true);
  });
});

describe("preview token", () => {
  const runId = "0c1d2e3f-0000-4000-8000-000000000001";
  it("is valid until cutoff, bound to the run and the secret", () => {
    const exp = new Date("2026-11-18T22:00:00Z");
    const token = makePreviewToken(runId, exp, SECRET);
    expect(readPreviewToken(token, SECRET, new Date("2026-11-18T21:59:59Z"))).toEqual({ runId, expiresAt: exp });
    expect(readPreviewToken(token, SECRET, exp)).toBeNull();
    expect(readPreviewToken(token, "y".repeat(32), new Date("2026-11-17T00:00:00Z"))).toBeNull();
    const [, e, s] = token.split(".");
    expect(readPreviewToken(`0c1d2e3f-0000-4000-8000-000000000002.${e}.${s}`, SECRET, new Date("2026-11-17T00:00:00Z"))).toBeNull();
    expect(readPreviewToken(`${runId}.${Number(e) + 86400}.${s}`, SECRET, new Date("2026-11-17T00:00:00Z"))).toBeNull();
    expect(readPreviewToken("garbage", SECRET)).toBeNull();
  });
});

describe("JotForm form registry", () => {
  it("parses the example file and refuses incomplete entries", async () => {
    const fs = await import("node:fs");
    const json = fs.readFileSync(new URL("../../../config/jotform-forms.example.json", import.meta.url), "utf8");
    const maps = parseJotformForms(json);
    expect(maps).toHaveLength(9);
    expect(new Set(maps.map((m) => m.type)).size).toBe(9);
    expect(parseJotformForms(undefined)).toEqual([]);
    expect(() => parseJotformForms(JSON.stringify([{ formId: "1", type: "rate_change" }]))).toThrow(/missing clientKey/);
    expect(() => parseJotformForms(JSON.stringify([{ formId: "1", type: "bonus", clientKey: "c", effectiveDateKey: "d", submittedByKey: "s", fields: {} }]))).toThrow(/unknown type/);
  });
});

describe("PDF and profile rendering", () => {
  it("renders markdown with headings and tables to a multi-page PDF", async () => {
    const md = renderProfileMarkdown({ ...profile(), signedAt: "2026-10-20T15:00:00.000Z" }, "Payroll Specialist");
    expect(md).toContain("| Pastor Daniel Reyes | g_1001 | active | 2019-03-01 | salary | $96,000.00 |");
    expect(md).toContain("| Pastor Daniel Reyes | $36,000.00 | $1,500.00 | 2025-12-10 | 2026-01-01 onward | box_12345 |");
    const long = `${md}\n\n## Filler\n\n${Array.from({ length: 120 }, (_, i) => `Line ${i} of filler text to force a second page.`).join("\n\n")}`;
    const bytes = await renderPdf(long, "Payroll Profile Grace Fellowship");
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Payroll Profile Grace Fellowship");
  });
});

describe("token encryption", () => {
  it("round-trips and refuses tampering or a different key", async () => {
    const { encrypt, decrypt } = await import("../lib/crypto");
    const blob = encrypt("refresh-token-value", SECRET);
    expect(blob).not.toContain("refresh-token-value");
    expect(decrypt(blob, SECRET)).toBe("refresh-token-value");
    expect(encrypt("x", SECRET)).not.toBe(encrypt("x", SECRET)); // fresh iv each time
    expect(() => decrypt(blob, "z".repeat(32))).toThrow();
    const [iv, ct, tag] = blob.split(".");
    expect(() => decrypt(`${iv}.${ct}.${tag!.slice(0, -2)}AA`, SECRET)).toThrow();
  });
});
