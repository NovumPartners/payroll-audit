import { describe, expect, it } from "vitest";
import { ALL_CHECKS, runChecks, renderReportMarkdown, renderPreviewMarkdown, DEFAULT_CONFIG } from "../src/index";
import type { RunInput } from "../src/types";
import { AS_OF, base, draft, emp, request } from "./fixtures";

describe("engine", () => {
  it("registers 22 checks in spec order", () => {
    expect(ALL_CHECKS.map((c) => c.code)).toEqual([
      "A1", "A2", "A3", "A4", "A5",
      "B1", "B2", "B3", "B4", "B5", "B6", "B7",
      "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8",
      "D1", "D2",
    ]);
    expect(new Set(ALL_CHECKS.map((c) => c.code)).size).toBe(22);
  });

  it("passes a clean run with no exceptions of any severity", () => {
    const r = runChecks(base());
    expect(r.exceptions).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(r.counts).toEqual({ block: 0, review: 0, info: 0 });
    expect(renderReportMarkdown(r)).toContain("PASS");
  });

  it("is deterministic across input ordering", () => {
    const a = base();
    const b = base();
    // reverse every collection in b; the report must be byte-identical
    b.draft.employees.reverse();
    b.prior!.employees.reverse();
    b.profile.employees.reverse();
    b.profile.benefitElections.reverse();
    const bonus = (id: string) => request({ id, type: "one_time_pay", employeeId: "e_admin", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 1 } });
    a.ledger = [bonus("cr_a"), bonus("cr_b")];
    b.ledger = [bonus("cr_b"), bonus("cr_a")];
    const admA = emp(a.draft, "g_1002");
    const admB = emp(b.draft, "g_1002");
    for (const adm of [admA, admB]) {
      adm.earnings.push({ type: "bonus", amountCents: 2 });
      adm.grossCents += 2;
    }
    const ra = runChecks(a);
    const rb = runChecks(b);
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    expect(ra.exceptions.length).toBeGreaterThan(0);
  });

  it("is a pure function of its input (same input twice, same output)", () => {
    const i = base();
    i.draft.blockers = [{ code: "x", message: "y" }];
    expect(JSON.stringify(runChecks(i))).toBe(JSON.stringify(runChecks(base() && i)));
  });

  it("verdict is pass only when no block and no review is open; info alone passes", () => {
    const i = base();
    emp(i.draft, "g_1001").ytdHousingCents = undefined; // C2 info: cap not verifiable
    const r = runChecks(i);
    expect(r.counts).toEqual({ block: 0, review: 0, info: 1 });
    expect(r.verdict).toBe("pass");
  });

  it("orders exceptions by severity, then employee, then check", () => {
    const i = base();
    i.draft.blockers = [{ code: "bank", message: "unverified" }];
    emp(i.draft, "g_1003").hours = 200;
    emp(i.draft, "g_1001").taxes.federalWithholdingCents = 1;
    const r = runChecks(i);
    const sev = r.exceptions.map((e) => e.severity);
    expect(sev).toEqual([...sev].sort((x, y) => ({ block: 0, review: 1, info: 2 })[x] - ({ block: 0, review: 1, info: 2 })[y]));
    const blocks = r.exceptions.filter((e) => e.severity === "block").map((e) => e.employeeName ?? "");
    expect(blocks).toEqual([...blocks].sort());
  });

  it("applies per-client threshold overrides", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 250000 + 5001 }];
    a.grossCents = 255001;
    expect(runChecks(i).exceptions.map((e) => e.checkCode)).toContain("B1");
    i.config = { grossMoveMinCents: 10000 };
    expect(runChecks(i).exceptions.map((e) => e.checkCode)).not.toContain("B1");
    expect(DEFAULT_CONFIG.grossMoveMinCents).toBe(5000);
  });

  it("runs without a prior period: family B is silent, the rest still runs", () => {
    const i = base();
    i.prior = undefined;
    const r = runChecks({ ...i, asOf: AS_OF, draft: draft() });
    expect(r.verdict).toBe("pass");
    expect(r.summary.priorHeadcount).toBeUndefined();
    i.draft.blockers = [{ code: "x", message: "y" }];
    expect(runChecks(i).exceptions.map((e) => e.checkCode)).toEqual(["D1"]);
  });
});

describe("movements and the client preview", () => {
  it("lists every line that moved with the ledger's reason", () => {
    const i = base();
    i.ledger = [request({ id: "cr_bonus", type: "one_time_pay", employeeId: "e_pastor", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 10000 } })];
    const p = emp(i.draft, "g_1001");
    p.earnings.push({ type: "bonus", amountCents: 10000 });
    p.grossCents += 10000;
    const f = emp(i.draft, "g_1003");
    f.hours = 84;
    f.earnings = [{ type: "regular", amountCents: 2200 * 84, hours: 84 }];
    f.grossCents = 2200 * 84;
    const r = runChecks(i);
    expect(r.summary.movements).toEqual([
      { employeeId: "e_pastor", employeeName: "Pastor Daniel Reyes", priorGrossCents: 550000, grossCents: 560000, deltaCents: 10000, reason: "one_time_pay cr_bonus" },
      { employeeId: "e_fac", employeeName: "Tom Hale", priorGrossCents: 176000, grossCents: 184800, deltaCents: 8800, reason: "hours 80 to 84 at $22.00" },
    ]);
    const md = renderPreviewMarkdown(r);
    expect(md).toContain("Headcount 3 (prior 3)");
    expect(md).toContain("| Tom Hale | $1,760.00 | $1,848.00 | +$88.00 | hours 80 to 84 at $22.00 |");
    expect(md).not.toContain("B1");
  });

  it("names arrivals and departures", () => {
    const i = base();
    i.draft.employees = i.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    const r = runChecks(i);
    expect(r.summary.movements).toEqual([
      { employeeId: "e_fac", employeeName: "Tom Hale", priorGrossCents: 176000, deltaCents: -176000, reason: "not in this run (no request on the ledger)" },
    ]);
  });
});

describe("report", () => {
  it("renders exceptions as a table and escapes pipes", () => {
    const i = base();
    i.draft.blockers = [{ code: "bank_unverified", message: "Company bank account | not verified" }];
    const md = renderReportMarkdown(runChecks(i));
    expect(md).toContain("| block | D1 |");
    expect(md).toContain("account \\| not verified");
    expect(md).toContain("Grace Fellowship");
  });
});

export type { RunInput };
