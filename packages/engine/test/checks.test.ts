import { describe, expect, it } from "vitest";
import { ALL_CHECKS, runChecks, renderReportMarkdown } from "../src/index.js";
import type { RunInput } from "../src/types.js";
import { AS_OF, base, draft, emp, request } from "./fixtures.js";

function codes(input: RunInput): string[] {
  return runChecks(input).exceptions.map((e) => e.checkCode);
}

function expectOnly(input: RunInput, code: string, min = 1) {
  const r = runChecks(input);
  const hits = r.exceptions.filter((e) => e.checkCode === code);
  const others = r.exceptions.filter((e) => e.checkCode !== code);
  expect(hits.length, `${code} should fire; got ${JSON.stringify(r.exceptions, null, 1)}`).toBeGreaterThanOrEqual(min);
  expect(others.map((e) => e.checkCode), `only ${code} should fire`).toEqual([]);
  return hits;
}

describe("engine", () => {
  it("registers 22 checks", () => {
    expect(ALL_CHECKS.map((c) => c.code)).toEqual([
      "A1", "A2", "A3", "A4", "A5",
      "B1", "B2", "B3", "B4", "B5", "B6", "B7",
      "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8",
      "D1", "D2",
    ]);
  });

  it("passes a clean run", () => {
    const r = runChecks(base());
    expect(r.exceptions).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(renderReportMarkdown(r)).toContain("PASS");
  });
});

describe("Family A: ledger to platform", () => {
  it("A1 applied rate change not reflected in draft", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", payload: { kind: "rate_change", newRateCents: 6300000 } })];
    // draft still shows the old rate and old regular pay
    const r = runChecks(i).exceptions;
    expect(r.map((e) => e.checkCode)).toContain("A1");
    expect(r.find((e) => e.checkCode === "A1")?.employeeName).toBe("Maria Soto");
  });

  it("A1 passes when the rate change is applied", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", payload: { kind: "rate_change", newRateCents: 6300000 } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 6300000;
    a.earnings = [{ type: "regular", amountCents: 262500 }];
    a.grossCents = 262500;
    expect(codes(i)).toEqual([]);
  });

  it("A2 mid-period rate change prorated wrong", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", effectiveDate: "2026-11-08", payload: { kind: "rate_change", newRateCents: 7200000 } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 7200000;
    a.earnings = [{ type: "regular", amountCents: 300000 }]; // full new rate, not prorated
    a.grossCents = 300000;
    expect(codes(i)).toContain("A2");
  });

  it("A3 new hire paid before hire date", () => {
    const i = base();
    i.profile.employees.push({
      id: "e_new", platformEmployeeId: "g_1004", name: "Ana Price", status: "active", hireDate: "2026-11-09",
      payType: "hourly", rateCents: 2000, rateEffectiveDate: "2026-11-09", standardHours: 80, workState: "TX",
      isMinister: false, ficaExempt: false, fedWithholdingVoluntary: true,
    });
    i.ledger = [request({ type: "new_hire", employeeId: "e_new", effectiveDate: "2026-11-09", payload: { kind: "new_hire", payType: "hourly", rateCents: 2000, hireDate: "2026-11-09" } })];
    i.draft.employees.push({
      platformEmployeeId: "g_1004", name: "Ana Price", payType: "hourly", rateCents: 2000, hours: 80,
      earnings: [{ type: "regular", amountCents: 160000, hours: 80 }], deductions: [],
      taxes: { socialSecurityEmployeeCents: 9920, medicareEmployeeCents: 2320, socialSecurityEmployerCents: 9920, medicareEmployerCents: 2320, federalWithholdingCents: 8000 },
      grossCents: 160000, netCents: 139760, workState: "TX", periodStart: "2026-11-01",
    });
    expect(codes(i)).toContain("A3");
  });

  it("A4 terminated employee still paid", () => {
    const i = base();
    i.ledger = [request({ type: "termination", employeeId: "e_fac", effectiveDate: "2026-10-24", payload: { kind: "termination", terminationDate: "2026-10-24", payoutAccruedTimeOff: false } })];
    expectOnly(i, "A4");
  });

  it("A5 received request not applied", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", status: "received", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 50000 } })];
    expectOnly(i, "A5");
  });
});

describe("Family B: platform to prior period", () => {
  it("B1 gross moved with no request", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 275000 }];
    a.grossCents = 275000;
    // C1 also fires because regular no longer matches the profile salary; B1 is the prior-period view
    const r = runChecks(i).exceptions.map((e) => e.checkCode);
    expect(r).toContain("B1");
    expect(r).toContain("C1");
  });

  it("B1 hourly rate moved with no request", () => {
    const i = base();
    emp(i.draft, "g_1003").rateCents = 2400;
    const r = codes(i);
    expect(r).toContain("B1");
  });

  it("B2 employee dropped with no termination", () => {
    const i = base();
    i.draft.employees = i.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    const r = codes(i);
    expect(r).toContain("B2");
    expect(r).toContain("B7"); // 18% drop in client gross is also surfaced
  });

  it("B2 employee added with no hire request", () => {
    const i = base();
    i.draft.employees.push({
      platformEmployeeId: "g_9999", name: "Unknown Person", payType: "hourly", rateCents: 1500, hours: 20,
      earnings: [{ type: "regular", amountCents: 30000, hours: 20 }], deductions: [],
      taxes: { socialSecurityEmployeeCents: 0, medicareEmployeeCents: 0, socialSecurityEmployerCents: 0, medicareEmployerCents: 0, federalWithholdingCents: 0 },
      grossCents: 30000, netCents: 30000, workState: "TX",
    });
    expectOnly(i, "B2");
  });

  it("B3 hours over 1.5x standard", () => {
    const i = base();
    const f = emp(i.draft, "g_1003");
    f.hours = 100; // 80 standard, cap 80 -> fires
    f.earnings = [{ type: "regular", amountCents: 2200 * 100, hours: 100 }];
    f.grossCents = 2200 * 100;
    const r = codes(i);
    expect(r).toContain("B3");
  });

  it("B4 bonus with no one-time pay request", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "bonus", amountCents: 50000 });
    a.grossCents += 50000;
    const r = codes(i);
    expect(r).toContain("B4");
    expect(r).toContain("B1");
  });

  it("B4 passes with a matching one-time pay request", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 40000 } })];
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "bonus", amountCents: 40000 });
    a.grossCents += 40000;
    expect(codes(i)).toEqual([]);
  });

  it("B5 deduction changed with no request", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    const med = a.deductions.find((d) => d.planId === "med_ppo")!;
    med.employeeCents = 25000;
    const r = codes(i);
    expect(r).toContain("B5");
    expect(r).toContain("C5");
  });

  it("B6 net dropped below half", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.netCents = 60000;
    expectOnly(i, "B6");
  });

  it("B7 client gross moved more than 5 percent", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_pastor", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 200000 } })];
    const p = emp(i.draft, "g_1001");
    p.earnings.push({ type: "bonus", amountCents: 200000 });
    p.grossCents += 200000;
    expectOnly(i, "B7");
  });
});

describe("Family C: platform to profile", () => {
  it("C1 rate differs from profile", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.rateCents = 6500000;
    const r = codes(i);
    expect(r).toContain("C1");
  });

  it("C2 housing per period differs from designation", () => {
    const i = base();
    const p = emp(i.draft, "g_1001");
    p.earnings = [{ type: "regular", amountCents: 400000 }, { type: "housing_allowance", amountCents: 200000, excludedFromTaxableWages: true }];
    p.grossCents = 600000;
    const r = codes(i);
    expect(r).toContain("C2");
  });

  it("C2 run would exceed annual designation", () => {
    const i = base();
    emp(i.draft, "g_1001").ytdHousingCents = 3500000;
    expectOnly(i, "C2");
  });

  it("C2 housing on a non-minister", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "housing_allowance", amountCents: 50000 });
    a.grossCents += 50000;
    const r = codes(i);
    expect(r).toContain("C2");
  });

  it("C3 FICA withheld from exempt minister", () => {
    const i = base();
    emp(i.draft, "g_1001").taxes.socialSecurityEmployeeCents = 24800;
    expectOnly(i, "C3");
  });

  it("C3 federal withholding with no voluntary election", () => {
    const i = base();
    emp(i.draft, "g_1001").taxes.federalWithholdingCents = 30000;
    expectOnly(i, "C3");
  });

  it("C4 housing earning type taxable", () => {
    const i = base();
    i.draft.platformHousingEarningExcluded = false;
    expectOnly(i, "C4");
  });

  it("C5 elected benefit missing from draft", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.deductions = a.deductions.filter((d) => d.planId !== "403b");
    const r = codes(i);
    expect(r).toContain("C5");
  });

  it("C5 deduction running with no election", () => {
    const i = base();
    emp(i.draft, "g_1003").deductions.push({ planId: "dental", name: "Dental", employeeCents: 3000, employerCents: 0, preTax: true });
    const r = codes(i);
    expect(r).toContain("C5");
  });

  it("C6 platform accrual rate differs", () => {
    const i = base();
    i.draft.platformAccruals = { "PTO Standard": { rateHours: 6, capHours: 120 } };
    expectOnly(i, "C6");
  });

  it("C6 balance outside tolerance", () => {
    const i = base();
    emp(i.draft, "g_1002").timeOffBalanceHours = 100; // prior 60 + 4 = 64 expected
    expectOnly(i, "C6");
  });

  it("C7 wrong pay frequency", () => {
    const i = base();
    i.draft.payFrequency = "biweekly";
    const r = codes(i);
    expect(r).toContain("C7");
  });

  it("C7 pay date before period end", () => {
    const i = base();
    i.draft.period = { ...i.draft.period, payDate: "2026-11-10" };
    expectOnly(i, "C7");
  });

  it("C8 work state with no registration", () => {
    const i = base();
    emp(i.draft, "g_1003").workState = "OK";
    const hits = expectOnly(i, "C8", 2);
    expect(hits.some((h) => h.actual.includes("no registration"))).toBe(true);
  });
});

describe("Family D: platform and calendar", () => {
  it("D1 platform blocker", () => {
    const i = base();
    i.draft.blockers = [{ code: "missing_ssn", message: "Employee is missing an SSN", employeeId: "g_1003" }];
    const hits = expectOnly(i, "D1");
    expect(hits[0]?.employeeName).toBe("Tom Hale");
  });

  it("D2 anniversary step increase with no request", () => {
    const i = base();
    const f = i.profile.employees.find((e) => e.id === "e_fac")!;
    f.hireDate = "2024-11-10";
    f.anniversaryStepIncrease = true;
    expectOnly(i, "D2");
  });

  it("D2 housing designation expiring soon", () => {
    const i = base();
    i.profile.housingAllowances[0]!.effectiveTo = "2026-12-31";
    i.asOf = "2026-11-18"; // 43 days out
    expectOnly(i, "D2");
  });

  it("D2 benefit eligibility reached with no election", () => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_fac")!.benefitEligibilityDate = "2026-11-05";
    expectOnly(i, "D2");
  });
});

describe("report", () => {
  it("renders exceptions as a table", () => {
    const i = base();
    i.draft.blockers = [{ code: "bank_unverified", message: "Company bank account not verified" }];
    const md = renderReportMarkdown(runChecks(i));
    expect(md).toContain("| block | D1 |");
    expect(md).toContain("Grace Fellowship");
  });

  it("runs without a prior period", () => {
    const i = base();
    i.prior = undefined;
    expect(runChecks({ ...i, asOf: AS_OF, draft: draft() }).verdict).toBe("pass");
  });
});
