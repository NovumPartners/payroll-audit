import { describe, expect, it } from "vitest";
import { runChecks } from "../src/index";
import { base, emp, request } from "./fixtures";
import type { RunInput } from "../src/types";

const codes = (i: RunInput) => runChecks(i).exceptions.map((e) => e.checkCode);
const hits = (i: RunInput, code: string) => runChecks(i).exceptions.filter((e) => e.checkCode === code);

describe("C1 compensation matches profile", () => {
  it("fails: rate differs from profile", () => {
    const i = base();
    emp(i.draft, "g_1002").rateCents = 6500000;
    expect(hits(i, "C1")[0]?.actual).toContain("rate $65,000.00 (profile $60,000.00)");
  });
  it("fails: pay type differs", () => {
    const i = base();
    emp(i.draft, "g_1003").payType = "salary";
    expect(hits(i, "C1")[0]?.actual).toContain("pay type salary (profile hourly)");
  });
  it("fails: platform standard hours differ for an hourly employee; passes when equal or not reported", () => {
    const i = base();
    emp(i.draft, "g_1003").standardHours = 60;
    expect(hits(i, "C1")[0]?.actual).toContain("standard hours 60 (profile 80)");
    emp(i.draft, "g_1003").standardHours = 80;
    expect(codes(i)).toEqual([]);
  });
  it("fails: base salary off by more than the tolerance; passes inside it", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 250101 }];
    expect(codes(i)).toContain("C1");
    a.earnings = [{ type: "regular", amountCents: 250100 }];
    expect(codes(i)).not.toContain("C1");
  });
  it("passes: salary split across regular and PTO lines", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 200000 }, { type: "pto", amountCents: 50000, hours: 16 }];
    a.timeOffBalanceHours = 48; // 16 hours used
    expect(codes(i)).toEqual([]);
  });
  it("prorates for a hire inside the period from the profile hire date", () => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_admin")!.hireDate = "2026-11-09";
    // 7/15 of $2,500 = $1,166.67
    expect(hits(i, "C1")[0]?.actual).toContain("expected $1,166.67, prorated");
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 116667 }];
    a.grossCents = 116667;
    expect(codes(i).filter((c) => c === "C1")).toEqual([]);
  });
  it("hands a pending rate change to A2 and only checks the new rate", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", effectiveDate: "2026-11-08", payload: { kind: "rate_change", newRateCents: 7200000 } })];
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 1 }];
    expect(hits(i, "C1")[0]?.actual).toBe("rate $60,000.00 (profile $72,000.00)");
    a.rateCents = 7200000;
    expect(codes(i)).not.toContain("C1");
    expect(codes(i)).toContain("A2");
  });
});

describe("C2 housing designation", () => {
  it("fails: per-period amount differs from the designation", () => {
    const i = base();
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 400000 }, { type: "housing_allowance", amountCents: 200000, excludedFromTaxableWages: true }];
    p.grossCents = 600000;
    expect(hits(i, "C2")[0]?.expected).toBe("housing $1,500.00 per period (resolution 2025-12-10)");
  });
  it("fails: designated minister with no housing line", () => {
    const i = base();
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 550000 }];
    expect(hits(i, "C2")[0]?.actual).toBe("no housing line");
  });
  it("annual cap: passes at exactly the annual amount, fails one cent over", () => {
    const i = base();
    emp(i.draft, "g_1001").ytdHousingCents = 3450000; // + 150,000 = 3,600,000
    expect(codes(i)).toEqual([]);
    emp(i.draft, "g_1001").ytdHousingCents = 3450001;
    expect(codes(i)).toEqual(["C2"]);
    expect(hits(i, "C2")[0]?.actual).toBe("year-to-date housing $36,000.01 after this run");
  });
  it("states the cap as unverified (info) when the platform reports no year-to-date figure", () => {
    const i = base();
    emp(i.draft, "g_1001").ytdHousingCents = undefined;
    const h = hits(i, "C2");
    expect(h).toHaveLength(1);
    expect(h[0]?.severity).toBe("info");
    expect(runChecks(i).verdict).toBe("pass");
  });
  it("fails: housing on a non-minister", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "housing_allowance", amountCents: 50000 });
    a.grossCents += 50000;
    expect(hits(i, "C2")[0]?.expected).toBe("no housing allowance (not a minister on the profile)");
  });
  it("fails: minister paid housing with no resolution on file", () => {
    const i = base();
    i.profile.housingAllowances = [];
    expect(hits(i, "C2")[0]?.actual).toBe("housing $1,500.00 with no designation");
  });
  it("an expired designation is treated as no designation", () => {
    const i = base();
    i.profile.housingAllowances[0]!.effectiveTo = "2026-10-31";
    expect(hits(i, "C2")[0]?.actual).toBe("housing $1,500.00 with no designation");
  });
  it("defers to A1 while a housing change is pending this period", () => {
    const i = base();
    i.ledger = [request({ type: "housing_change", employeeId: "e_pastor", payload: { kind: "housing_change", annualAmountCents: 4800000, perPeriodAmountCents: 200000, resolutionDate: "2026-10-15" } })];
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 400000 }, { type: "housing_allowance", amountCents: 200000, excludedFromTaxableWages: true }];
    p.grossCents = 600000;
    expect(codes(i)).not.toContain("C2");
  });
});

describe("C3 minister FICA and withholding", () => {
  it("fails: FICA withheld from an exempt minister (any of the four lines)", () => {
    for (const k of ["socialSecurityEmployeeCents", "medicareEmployeeCents", "socialSecurityEmployerCents", "medicareEmployerCents"] as const) {
      const i = base();
      emp(i.draft, "g_1001").taxes[k] = 1;
      expect(codes(i)).toEqual(["C3"]);
    }
  });
  it("fails: federal withholding with no voluntary election; passes with one", () => {
    const i = base();
    emp(i.draft, "g_1001").taxes.federalWithholdingCents = 30000;
    expect(codes(i)).toEqual(["C3"]);
    i.profile.employees.find((e) => e.id === "e_pastor")!.fedWithholdingVoluntary = true;
    expect(codes(i)).toEqual([]);
  });
  it("review: a non-minister with wages and no FICA at all", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.taxes = { ...a.taxes, socialSecurityEmployeeCents: 0, medicareEmployeeCents: 0, socialSecurityEmployerCents: 0, medicareEmployerCents: 0 };
    const h = hits(i, "C3");
    expect(h).toHaveLength(1);
    expect(h[0]?.severity).toBe("review");
  });
  it("a minister the profile does not mark exempt is not held to zero FICA", () => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_pastor")!.ficaExempt = false;
    emp(i.draft, "g_1001").taxes.socialSecurityEmployeeCents = 1;
    expect(codes(i)).toEqual([]);
  });
});

describe("C4 housing earning type taxability", () => {
  it("fails: platform earning type configured taxable", () => {
    const i = base();
    i.draft.platformHousingEarningExcluded = false;
    expect(codes(i)).toEqual(["C4"]);
    expect(hits(i, "C4")[0]?.severity).toBe("block");
  });
  it("review: platform cannot report it and the profile carries no confirmation; passes once confirmed", () => {
    const i = base();
    i.draft.platformHousingEarningExcluded = undefined;
    emp(i.draft, "g_1001").earnings[1]!.excludedFromTaxableWages = undefined;
    expect(hits(i, "C4")[0]?.severity).toBe("review");
    i.profile.housingEarningTypeConfirmedExcluded = true;
    expect(codes(i)).toEqual([]);
  });
  it("fails: a housing line flagged taxable even when the type is excluded", () => {
    const i = base();
    emp(i.draft, "g_1001").earnings[1]!.excludedFromTaxableWages = false;
    expect(hits(i, "C4")[0]?.actual).toBe("housing $1,500.00 taxable");
  });
  it("is silent when nobody is paid housing", () => {
    const i = base();
    i.draft.platformHousingEarningExcluded = false;
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 550000 }];
    expect(codes(i)).not.toContain("C4");
  });
});

describe("C5 benefit elections", () => {
  it("fails: elected benefit missing from draft", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.deductions = a.deductions.filter((d) => d.planId !== "403b");
    expect(hits(i, "C5")[0]?.actual).toBe("plan missing from draft");
  });
  it("fails: amount or tax treatment differs", () => {
    const i = base();
    const med = emp(i.draft, "g_1002").deductions.find((d) => d.planId === "med_ppo")!;
    med.employerCents = 1;
    med.preTax = false;
    expect(hits(i, "C5")[0]?.actual).toBe("Medical PPO employer $0.01, post-tax");
  });
  it("fails: deduction running with no election", () => {
    const i = base();
    emp(i.draft, "g_1003").deductions.push({ planId: "dental", name: "Dental", employeeCents: 3000, employerCents: 0, preTax: true });
    expect(hits(i, "C5")[0]?.expected).toBe("no Dental deduction (no election on profile)");
  });
  it("info: tax treatment not reported by the platform, amounts still checked", () => {
    const i = base();
    for (const d of emp(i.draft, "g_1002").deductions) d.preTax = undefined;
    const h = hits(i, "C5");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ severity: "info", actual: "2 benefit lines with tax treatment not reported by the platform" });
    emp(i.draft, "g_1002").deductions[0]!.employeeCents = 1;
    expect(hits(i, "C5").map((e) => e.severity)).toEqual(["block", "info"]);
  });
  it("defers a plan with a pending benefit change to A1", () => {
    const i = base();
    i.ledger = [request({ type: "benefit_change", employeeId: "e_admin", payload: { kind: "benefit_change", planId: "med_ppo", employeeDeductionCents: 1, employerContributionCents: 1 } })];
    expect(codes(i)).toEqual(["A1"]);
  });
  it("an election that ended before the period is not expected", () => {
    const i = base();
    i.profile.benefitElections.find((b) => b.planId === "403b")!.effectiveTo = "2026-10-31";
    const a = emp(i.draft, "g_1002");
    a.deductions = a.deductions.filter((d) => d.planId !== "403b");
    expect(codes(i)).toEqual(["B5"]); // only the prior-period comparison notices
  });
});

describe("C6 time-off", () => {
  it("fails: platform accrual rate differs", () => {
    const i = base();
    i.draft.platformAccruals = { "PTO Standard": { rateHours: 6, capHours: 120 } };
    expect(codes(i)).toEqual(["C6"]);
  });
  it("fails: cap differs in either direction, or the policy is missing", () => {
    const i = base();
    i.draft.platformAccruals = { "PTO Standard": { rateHours: 4 } };
    expect(hits(i, "C6")[0]?.actual).toBe("PTO Standard: 4h, no cap");
    i.draft.platformAccruals = {};
    expect(hits(i, "C6")[0]?.actual).toBe("PTO Standard not configured on the platform");
    i.draft.platformAccruals = undefined; // platform does not report policies
    expect(codes(i)).toEqual([]);
  });
  it("balance: tolerance is one accrual period; passes at the edge, fails beyond it", () => {
    // prior 60 + 4 accrued = 64, tolerance 4
    const i = base();
    emp(i.draft, "g_1002").timeOffBalanceHours = 68;
    expect(codes(i)).toEqual([]);
    emp(i.draft, "g_1002").timeOffBalanceHours = 68.1;
    expect(codes(i)).toEqual(["C6"]);
    emp(i.draft, "g_1002").timeOffBalanceHours = 60;
    expect(codes(i)).toEqual([]);
    emp(i.draft, "g_1002").timeOffBalanceHours = 59.9;
    expect(codes(i)).toEqual(["C6"]);
  });
  it("balance: hours used come from the pto lines", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 200000 }, { type: "pto", amountCents: 50000, hours: 16 }];
    a.timeOffBalanceHours = 48; // 60 + 4 - 16
    expect(codes(i)).toEqual([]);
  });
  it("balance: capped at the policy cap", () => {
    const i = base();
    emp(i.prior!, "g_1002").timeOffBalanceHours = 119;
    emp(i.draft, "g_1002").timeOffBalanceHours = 120;
    expect(codes(i)).toEqual(["D2"]); // at cap is D2's news, not a C6 variance
  });
  it("per-hour accrual uses hours on the draft", () => {
    const i = base();
    i.profile.timeOffPolicies[0] = { policyName: "PTO Standard", accrualRateHours: 0.05, accrualBasis: "per_hour", capHours: 120, assignedEmployeeIds: ["e_fac"] };
    i.draft.platformAccruals = { "PTO Standard": { rateHours: 0.05, capHours: 120 } };
    emp(i.draft, "g_1003").timeOffBalanceHours = 40; // prior 36 + 0.05 * 80 = 40
    expect(codes(i)).toEqual([]);
  });
});

describe("C7 pay schedule", () => {
  it("fails: wrong pay frequency", () => {
    const i = base();
    i.draft.payFrequency = "biweekly";
    expect(codes(i)).toContain("C7");
  });
  it("passes: frequency moved by a schedule_change request", () => {
    const i = base();
    i.ledger = [request({ type: "schedule_change", effectiveDate: "2026-11-02", payload: { kind: "schedule_change", payFrequency: "biweekly" } })];
    i.draft.payFrequency = "biweekly";
    i.draft.period = { start: "2026-11-02", end: "2026-11-15", payDate: "2026-11-20" };
    expect(codes(i)).not.toContain("C7");
    expect(codes(i)).toContain("C1"); // salaries are still at the semimonthly amount; C1 says so
  });
  it("fails: period length does not fit the frequency", () => {
    const i = base();
    i.draft.period = { start: "2026-11-01", end: "2026-11-20", payDate: "2026-11-25" };
    expect(hits(i, "C7")[0]?.expected).toBe("period length 13 to 16 days for semimonthly");
  });
  it("fails: pay date before period end", () => {
    const i = base();
    i.draft.period = { ...i.draft.period, payDate: "2026-11-10" };
    expect(codes(i)).toEqual(["C7"]);
  });
  it("pay date lag: allows up to 3 days early, never late", () => {
    const i = base();
    i.profile.expectedPayDateLagDays = 5; // Nov 20
    expect(codes(i)).toEqual([]);
    i.draft.period = { ...i.draft.period, payDate: "2026-11-17" };
    expect(codes(i)).toEqual([]);
    i.draft.period = { ...i.draft.period, payDate: "2026-11-16" };
    expect(codes(i)).toEqual(["C7"]);
    i.draft.period = { ...i.draft.period, payDate: "2026-11-21" };
    expect(codes(i)).toEqual(["C7"]);
  });
});

describe("C8 work state", () => {
  it("fails: work state differs and the state is unregistered on both profile and platform", () => {
    const i = base();
    emp(i.draft, "g_1003").workState = "OK";
    const h = hits(i, "C8");
    expect(h).toHaveLength(3);
    expect(h.map((x) => x.sourceOfExpected).sort()).toEqual(["platform_rule", "profile", "profile"]);
  });
  it("fails: profile registered but platform setup incomplete", () => {
    const i = base();
    i.profile.registeredStates = ["TX", "OK"];
    i.profile.employees.find((e) => e.id === "e_fac")!.workState = "OK";
    emp(i.draft, "g_1003").workState = "OK";
    const h = hits(i, "C8");
    expect(h).toHaveLength(1);
    expect(h[0]?.actual).toBe("no tax setup for OK");
  });
  it("falls back to the profile list when the platform reports no tax setup", () => {
    const i = base();
    i.draft.stateTaxSetup = undefined;
    expect(codes(i)).toEqual([]);
    i.profile.employees.find((e) => e.id === "e_fac")!.workState = "OK";
    emp(i.draft, "g_1003").workState = "OK";
    expect(hits(i, "C8")).toHaveLength(1);
  });
  it("fails: platform has no work state at all", () => {
    const i = base();
    emp(i.draft, "g_1003").workState = "";
    const h = hits(i, "C8");
    expect(h).toHaveLength(1);
    expect(h[0]?.actual).toBe("no work state on the platform");
  });
});
