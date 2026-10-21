import { describe, expect, it } from "vitest";
import { runChecks } from "../src/index.js";
import { base, emp, request } from "./fixtures.js";
import type { RunInput } from "../src/types.js";

const codes = (i: RunInput) => runChecks(i).exceptions.map((e) => e.checkCode);
const hits = (i: RunInput, code: string) => runChecks(i).exceptions.filter((e) => e.checkCode === code);

describe("B1 gross moved with no request", () => {
  const regular = (cents: number) => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: cents }];
    a.grossCents = cents;
    return i;
  };
  it("fails above the threshold (2% or $50, whichever is greater)", () => {
    // prior $2,500: 2% = $50 = floor, threshold $50
    expect(codes(regular(255001))).toContain("B1");
    expect(codes(regular(244999))).toContain("B1");
  });
  it("passes at exactly the threshold", () => {
    expect(codes(regular(255000))).not.toContain("B1");
    expect(codes(regular(245000))).not.toContain("B1");
  });
  it("uses the percentage when it is larger than the floor", () => {
    const i = base();
    const p = emp(i.draft, "g_1001");
    // pastor recurring $5,500: 2% = $110 > $50
    p.earnings = [{ type: "regular", amountCents: 411000 }, { type: "housing_allowance", amountCents: 150000, excludedFromTaxableWages: true }];
    p.grossCents = 561000;
    expect(codes(i)).not.toContain("B1");
    p.earnings[0]!.amountCents = 411001;
    p.grossCents = 561001;
    expect(codes(i)).toContain("B1");
  });
  it("fails: hourly rate moved with no request", () => {
    const i = base();
    emp(i.draft, "g_1003").rateCents = 2400;
    expect(hits(i, "B1")[0]?.actual).toBe("hourly rate $24.00");
  });
  it("passes: hourly hours moved (that is B3, not B1)", () => {
    const i = base();
    const f = emp(i.draft, "g_1003");
    f.hours = 70;
    f.earnings = [{ type: "regular", amountCents: 2200 * 70, hours: 70 }];
    f.grossCents = 2200 * 70;
    expect(codes(i)).not.toContain("B1");
  });
  it("passes: a one-time bonus in the prior period that is gone this period is not a move", () => {
    const i = base();
    const pa = emp(i.prior!, "g_1002");
    pa.earnings.push({ type: "bonus", amountCents: 100000 });
    pa.grossCents += 100000;
    expect(codes(i)).not.toContain("B1");
  });
  it("passes: a rate change request explains exactly its amount; fails when the move exceeds it", () => {
    const i = base();
    i.ledger = [request({ type: "rate_change", employeeId: "e_admin", payload: { kind: "rate_change", newRateCents: 7200000 } })];
    const a = emp(i.draft, "g_1002");
    a.rateCents = 7200000;
    a.earnings = [{ type: "regular", amountCents: 300000 }];
    a.grossCents = 300000;
    expect(codes(i)).not.toContain("B1");
    a.earnings = [{ type: "regular", amountCents: 305001 }];
    a.grossCents = 305001;
    expect(hits(i, "B1")[0]?.expected).toContain("prior $2,500.00 plus $500.00 from requests");
  });
  it("a small one-time pay request does not excuse a large recurring move", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 5000 } })];
    const a = emp(i.draft, "g_1002");
    a.earnings = [{ type: "regular", amountCents: 500000 }, { type: "bonus", amountCents: 5000 }];
    a.grossCents = 505000;
    expect(codes(i)).toContain("B1");
  });
  it("is silent for an employee whose prior period was a partial first period", () => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_admin")!.hireDate = "2026-10-20";
    const pa = emp(i.prior!, "g_1002");
    pa.earnings = [{ type: "regular", amountCents: 187500 }];
    pa.grossCents = 187500;
    expect(codes(i)).not.toContain("B1");
  });
});

describe("B2 headcount", () => {
  it("fails: employee dropped with no termination request", () => {
    const i = base();
    i.draft.employees = i.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    const r = codes(i);
    expect(r).toContain("B2");
    expect(r).toContain("B7"); // 18% drop in client gross is also surfaced
  });
  it("passes: drop explained by a termination request or by profile status", () => {
    const i = base();
    i.draft.employees = i.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    i.ledger = [request({ type: "termination", employeeId: "e_fac", effectiveDate: "2026-10-31", payload: { kind: "termination", terminationDate: "2026-10-31", payoutAccruedTimeOff: false } })];
    expect(codes(i)).not.toContain("B2");
    const j = base();
    j.draft.employees = j.draft.employees.filter((e) => e.platformEmployeeId !== "g_1003");
    j.profile.employees.find((e) => e.id === "e_fac")!.status = "leave";
    expect(codes(j)).not.toContain("B2");
  });
  it("fails: employee added with no hire request, even one not on the profile", () => {
    const i = base();
    i.draft.employees.push({
      platformEmployeeId: "g_9999", name: "Unknown Person", payType: "hourly", rateCents: 1500, hours: 20,
      earnings: [{ type: "regular", amountCents: 30000, hours: 20 }], deductions: [],
      taxes: { socialSecurityEmployeeCents: 0, medicareEmployeeCents: 0, socialSecurityEmployerCents: 0, medicareEmployerCents: 0, federalWithholdingCents: 0 },
      grossCents: 30000, netCents: 30000, workState: "TX",
    });
    expect(codes(i)).toEqual(["B2"]);
    expect(hits(i, "B2")[0]?.employeeName).toBe("Unknown Person");
  });
});

describe("B3 hours", () => {
  const hours = (h: number, freq: "semimonthly" | "biweekly" = "semimonthly") => {
    const i = base();
    const f = emp(i.draft, "g_1003");
    f.hours = h;
    f.earnings = [{ type: "regular", amountCents: Math.round(2200 * h), hours: h }];
    f.grossCents = Math.round(2200 * h);
    if (freq === "biweekly") {
      i.profile.payFrequency = "biweekly";
      i.draft.payFrequency = "biweekly";
      i.draft.period = { start: "2026-11-02", end: "2026-11-15", payDate: "2026-11-20" };
    }
    return i;
  };
  it("semimonthly: the 80-hour biweekly cap scales to 86.67; 86 passes, 87 fails", () => {
    expect(codes(hours(86))).not.toContain("B3");
    expect(hits(hours(87), "B3")[0]?.expected).toBe("hours at or under 86.67");
  });
  it("biweekly: 80 passes, 80.5 fails", () => {
    expect(codes(hours(80, "biweekly"))).not.toContain("B3");
    expect(codes(hours(80.5, "biweekly"))).toContain("B3");
  });
  it("1.5x standard binds when lower than the cap", () => {
    const i = hours(50);
    i.profile.employees.find((e) => e.id === "e_fac")!.standardHours = 30; // limit 45
    expect(hits(i, "B3")[0]?.expected).toBe("hours at or under 45");
  });
  it("ignores salaried employees", () => {
    const i = base();
    emp(i.draft, "g_1002").hours = 500;
    expect(codes(i)).not.toContain("B3");
  });
});

describe("B4 new earning type", () => {
  it("fails: bonus with no one-time pay request", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "bonus", amountCents: 50000 });
    a.grossCents += 50000;
    expect(hits(i, "B4")[0]?.actual).toBe("bonus $500.00 with no request");
    expect(codes(i)).not.toContain("B1"); // recurring lines did not move
  });
  it("passes: matching one-time pay request", () => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 40000 } })];
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "bonus", amountCents: 40000 });
    a.grossCents += 40000;
    expect(codes(i)).toEqual([]);
  });
  it("passes: an earning type that was already present last period", () => {
    const i = base();
    emp(i.prior!, "g_1002").earnings.push({ type: "cell_stipend", amountCents: 5000 });
    emp(i.draft, "g_1002").earnings.push({ type: "cell_stipend", amountCents: 5000 });
    expect(codes(i)).not.toContain("B4");
  });
  it("fails once per type, not once per line", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.earnings.push({ type: "retro", amountCents: 100 }, { type: "retro", amountCents: 200 });
    expect(hits(i, "B4")).toHaveLength(1);
    expect(hits(i, "B4")[0]?.actual).toBe("retro $3.00 with no request");
  });
});

describe("B5 deductions changed", () => {
  it("fails: deduction amount changed with no request", () => {
    const i = base();
    emp(i.draft, "g_1002").deductions.find((d) => d.planId === "med_ppo")!.employeeCents = 25000;
    const r = codes(i);
    expect(r).toContain("B5");
    expect(r).toContain("C5");
  });
  it("fails: deduction dropped since the prior period", () => {
    const i = base();
    const a = emp(i.draft, "g_1002");
    a.deductions = a.deductions.filter((d) => d.planId !== "403b");
    expect(hits(i, "B5")[0]?.actual).toBe("403(b) not on draft");
  });
  it("passes: change explained by a benefit_change request for that plan", () => {
    const i = base();
    i.ledger = [request({ type: "benefit_change", employeeId: "e_admin", payload: { kind: "benefit_change", planId: "med_ppo", employeeDeductionCents: 25000, employerContributionCents: 42000 } })];
    emp(i.draft, "g_1002").deductions.find((d) => d.planId === "med_ppo")!.employeeCents = 25000;
    expect(codes(i)).toEqual([]);
  });
  it("passes: a named post-tax deduction explained by a deduction_change request", () => {
    const i = base();
    i.ledger = [request({ type: "deduction_change", employeeId: "e_fac", payload: { kind: "deduction_change", deductionName: "Garnishment", amountCents: 7500 } })];
    emp(i.draft, "g_1003").deductions.push({ name: "Garnishment", employeeCents: 7500, employerCents: 0, preTax: false });
    expect(codes(i)).toEqual([]);
  });
});

describe("B6 net dropped", () => {
  // prior net $1,787.08; half is $893.54
  it("fails just under half; passes at exactly half", () => {
    const i = base();
    emp(i.draft, "g_1002").netCents = 89353;
    expect(hits(i, "B6")[0]?.expected).toContain("$893.54");
    emp(i.draft, "g_1002").netCents = 89354;
    expect(codes(i)).not.toContain("B6");
  });
  it("passes with any request on the ledger for the employee", () => {
    const i = base();
    emp(i.draft, "g_1002").netCents = 1;
    i.ledger = [request({ type: "deduction_change", employeeId: "e_admin", payload: { kind: "deduction_change", deductionName: "403(b)", amountCents: 12500 } })];
    expect(codes(i)).not.toContain("B6");
  });
});

describe("B7 client total gross", () => {
  // prior total $9,760.00; 5% = $488.00
  const withBonus = (cents: number) => {
    const i = base();
    i.ledger = [request({ type: "one_time_pay", employeeId: "e_pastor", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: cents } })];
    const p = emp(i.draft, "g_1001");
    p.earnings.push({ type: "bonus", amountCents: cents });
    p.grossCents += cents;
    return i;
  };
  it("passes at exactly 5%, fails one cent above", () => {
    expect(codes(withBonus(48800))).toEqual([]);
    expect(codes(withBonus(48801))).toEqual(["B7"]);
  });
});
