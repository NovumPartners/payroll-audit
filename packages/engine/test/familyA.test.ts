import { describe, expect, it } from "vitest";
import { runChecks } from "../src/index";
import { base, emp, request } from "./fixtures";
import type { RunInput } from "../src/types";

const codes = (i: RunInput) => runChecks(i).exceptions.map((e) => e.checkCode);
const hits = (i: RunInput, code: string) => runChecks(i).exceptions.filter((e) => e.checkCode === code);

describe("A1 applied requests appear in the draft", () => {
  it("fails: applied rate change not reflected", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", payload: { kind: "rate_change", newRateCents: 6300000 } })];
    const h = hits(i, "A1");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ employeeName: "Maria Soto", severity: "block", requestId: "cr_1", sourceOfExpected: "ledger" });
  });
  it("passes: rate change applied", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", payload: { kind: "rate_change", newRateCents: 6300000 } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 6300000;
    a.earnings = [{ type: "regular", amountCents: 262500 }];
    a.grossCents = 262500;
    expect(codes(i)).toEqual([]);
  });
  it("fails: housing change amount not on the draft; passes when it is", () => {
    const i = base();
    i.ledger = [request({ type: "housing_change", employeeId: "e_pastor", payload: { kind: "housing_change", annualAmountCents: 3840000, perPeriodAmountCents: 160000, resolutionDate: "2026-10-15" } })];
    expect(hits(i, "A1")).toHaveLength(1);
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 400000 }, { type: "housing_allowance", amountCents: 160000, excludedFromTaxableWages: true }];
    p.grossCents = 560000;
    expect(codes(i)).toEqual([]);
  });
  it("fails: benefit change applied with the wrong employer amount", () => {
    const i = base();
    i.ledger = [request({ type: "benefit_change", employeeId: "e_admin", payload: { kind: "benefit_change", planId: "med_ppo", employeeDeductionCents: 20000, employerContributionCents: 45000 } })];
    const med = emp(i.draft, "g_1002").deductions.find((d) => d.planId === "med_ppo")!;
    med.employeeCents = 20000; // employer still 42000
    expect(hits(i, "A1")).toHaveLength(1);
    med.employerCents = 45000;
    expect(codes(i)).toEqual([]);
  });
  it("fails: time-off policy change not on the platform; passes when applied", () => {
    const i = base();
    i.ledger = [request({ type: "time_off_change", payload: { kind: "time_off_change", policyName: "PTO Standard", accrualRateHours: 5, capHours: 120 } })];
    i.profile.timeOffPolicies[0]!.accrualRateHours = 5;
    expect(codes(i)).toContain("A1");
    i.draft.platformAccruals = { "PTO Standard": { rateHours: 5, capHours: 120 } };
    expect(codes(i)).toEqual([]);
  });
  it("fails: one-time pay applied but amount differs by a cent", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 40000 } })];
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "bonus", amountCents: 39999 });
    a.grossCents += 39999;
    expect(hits(i, "A1")[0]?.actual).toBe("bonus $399.99");
  });
  it("ignores rejected and received requests", () => {
    const i = base();
    i.ledger = [
      request({ id: "r1", type: "rate_change", employeeId: "e_admin", status: "rejected", payload: { kind: "rate_change", newRateCents: 6300000 } }),
    ];
    expect(codes(i)).toEqual([]);
  });
});

describe("A2 rate change proration", () => {
  const mid = (regular: number, prev?: number, profileRate = 6000000) => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_admin")!.rateCents = profileRate;
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", effectiveDate: "2026-11-08", payload: { kind: "rate_change", newRateCents: 7200000, previousRateCents: prev } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 7200000;
    a.earnings = [{ type: "regular", amountCents: regular }];
    a.grossCents = regular;
    return i;
  };
  // 7 of 15 calendar days at $2,500 + 8 of 15 at $3,000 = $1,166.67 + $1,600.00 = $2,766.67
  it("fails: full new rate paid for the whole period", () => {
    expect(hits(mid(300000), "A2")[0]).toMatchObject({ severity: "block", expected: "regular $2,766.67 (rate change effective 2026-11-08, calendar days)" });
  });
  it("passes at the exact prorated amount and inside the tolerance; fails one cent outside", () => {
    expect(codes(mid(276667))).toEqual([]);
    expect(codes(mid(276767))).toEqual([]);
    expect(codes(mid(276768))).toContain("A2");
    expect(codes(mid(276567))).toEqual([]);
    expect(codes(mid(276566))).toContain("A2");
  });
  it("uses work-day proration when configured", () => {
    const i = mid(0);
    i.config = { prorationMethod: "work_days" };
    // Nov 1-15 2026 has 10 work days: Nov 2-6 (5) and Nov 9-13 (5). 5 at $2,500 + 5 at $3,000 = $2,750
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 275000 }];
    a.grossCents = 275000;
    expect(codes(i)).toEqual([]);
  });
  it("takes the old rate from the request when the profile already carries the new rate", () => {
    expect(codes(mid(276667, 6000000, 7200000))).toEqual([]);
    expect(codes(mid(300000, 6000000, 7200000))).toContain("A2");
  });
  it("reports the proration as not verifiable when the old rate is lost, instead of guessing", () => {
    const h = hits(mid(276667, undefined, 7200000), "A2");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ severity: "review" });
    expect(h[0]?.actual).toContain("not verifiable");
  });
  it("a change effective on the first day needs no proration", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", effectiveDate: "2026-11-01", payload: { kind: "rate_change", newRateCents: 7200000 } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 7200000;
    a.earnings = [{ type: "regular", amountCents: 300000 }];
    a.grossCents = 300000;
    expect(codes(i).filter((c) => c !== "B7")).toEqual([]); // B7: the $500 raise alone moves client gross 5.1%
  });
});

describe("A3 new hires", () => {
  const hire = (payType: "hourly" | "salary", hireDate = "2026-11-09") => {
    const i = base();
    i.profile.employees.push({
      id: "e_new", platformEmployeeId: "g_1004", name: "Ana Price", status: "active", hireDate,
      payType, rateCents: payType === "hourly" ? 2000 : 4800000, rateEffectiveDate: hireDate, standardHours: payType === "hourly" ? 80 : 0, workState: "TX",
      isMinister: false, ficaExempt: false, fedWithholdingVoluntary: true,
    });
    i.ledger = [request({ type: "new_hire", employeeId: "e_new", effectiveDate: hireDate, payload: { kind: "new_hire", payType, rateCents: payType === "hourly" ? 2000 : 4800000, hireDate } })];
    return i;
  };
  const add = (i: RunInput, regular: number, extra: Partial<Parameters<typeof emp>[0]["employees"][number]> = {}) => {
    i.draft.employees.push({
      platformEmployeeId: "g_1004", name: "Ana Price", payType: "salary", rateCents: 4800000, hours: 0,
      earnings: [{ type: "regular", amountCents: regular }], deductions: [],
      taxes: { socialSecurityEmployeeCents: 1, medicareEmployeeCents: 1, socialSecurityEmployerCents: 1, medicareEmployerCents: 1, federalWithholdingCents: 0 },
      grossCents: regular, netCents: regular, workState: "TX", ...extra,
    });
  };
  it("fails: new hire missing from the draft", () => {
    expect(hits(hire("salary"), "A3")[0]?.actual).toBe("not in draft");
  });
  it("fails: hourly hire paid from before the hire date (platform first paid day)", () => {
    const i = hire("hourly");
    add(i, 160000, { payType: "hourly", rateCents: 2000, hours: 80, periodStart: "2026-11-01" });
    expect(hits(i, "A3")[0]?.actual).toContain("paid from 2026-11-01");
  });
  it("fails: salaried hire paid the full period; passes at the prorated amount", () => {
    // $4,800,000 / 24 = $2,000 per period; hired Nov 9 of a 15-day period = 7/15 = $933.33
    const full = hire("salary");
    add(full, 200000);
    expect(hits(full, "A3")[0]?.actual).toContain("exceeds $933.33 prorated from 2026-11-09");
    const ok = hire("salary");
    add(ok, 93333);
    expect(codes(ok).filter((c) => c === "A3" || c === "C1")).toEqual([]);
  });
  it("fails: pay type or rate differs from the request", () => {
    const i = hire("salary");
    add(i, 93333, { rateCents: 5000000 });
    expect(hits(i, "A3")[0]?.actual).toContain("rate $50,000.00");
  });
});

describe("A4 terminations", () => {
  const term = (date: string, payout = false, status: "applied_to_profile" | "received" = "applied_to_profile") =>
    request({ type: "termination", employeeId: "e_fac", effectiveDate: date, status, payload: { kind: "termination", terminationDate: date, payoutAccruedTimeOff: payout } });
  it("fails: employee terminated before the period is still paid", () => {
    const i = base();
    i.ledger = [term("2026-10-24")];
    const r = runChecks(i);
    expect(r.exceptions.map((e) => e.checkCode)).toEqual(["A4"]);
    expect(r.exceptions[0]?.description).toContain("still paid this period");
  });
  it("passes: terminated employee not in the draft and marked on the profile", () => {
    const i = base();
    i.ledger = [term("2026-10-24")];
    i.draft.employees = i.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    expect(codes(i).filter((c) => c !== "B7")).toEqual([]);
  });
  it("fails: final pay runs past the termination date (platform last paid day)", () => {
    const i = base();
    i.ledger = [term("2026-11-10")];
    emp(i.draft, "g_1003").periodEnd = "2026-11-15";
    expect(hits(i, "A4")[0]?.actual).toBe("paid through 2026-11-15");
  });
  it("fails: salaried final pay exceeds the amount prorated through the termination date", () => {
    const i = base();
    i.ledger = [request({ type: "termination", employeeId: "e_admin", effectiveDate: "2026-11-10", payload: { kind: "termination", terminationDate: "2026-11-10", payoutAccruedTimeOff: false } })];
    // 10/15 of $2,500 = $1,666.67
    expect(hits(i, "A4")[0]?.expected).toContain("$1,666.67");
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 166667 }];
    a.grossCents = 166667;
    expect(hits(i, "A4")).toEqual([]);
  });
  it("fails: requested time-off payout missing from the final check; passes when present", () => {
    const i = base();
    i.ledger = [term("2026-11-15", true)];
    expect(hits(i, "A4")[0]?.actual).toBe("no pto_payout earning line");
    emp(i.draft, "g_1003").earnings.push({ type: "pto_payout", amountCents: 88000, hours: 40 });
    emp(i.draft, "g_1003").grossCents += 88000;
    expect(hits(i, "A4")).toEqual([]);
    expect(codes(i)).not.toContain("B4"); // the payout is explained by the termination request
  });
  it("ignores a termination superseded by a later rehire on the profile", () => {
    const i = base();
    i.ledger = [term("2023-06-30")];
    expect(codes(i)).toEqual([]); // e_fac hired 2024-02-05
  });
  it("received terminations are A5's job, not A4's", () => {
    const i = base();
    i.ledger = [term("2026-11-10", false, "received")];
    expect(codes(i)).toEqual(["A5"]);
  });
});

describe("A5 received requests", () => {
  it("fails: received request effective this period", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", status: "received", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 50000 } })];
    expect(codes(i)).toEqual(["A5"]);
  });
  it("fails: received request effective before the period and never applied", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", status: "received", effectiveDate: "2026-10-01", payload: { kind: "rate_change", newRateCents: 1 } })];
    expect(codes(i)).toEqual(["A5"]);
  });
  it("passes: received request effective after the period", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", status: "received", effectiveDate: "2026-11-16", payload: { kind: "rate_change", newRateCents: 1 } })];
    expect(codes(i)).toEqual([]);
  });
});
