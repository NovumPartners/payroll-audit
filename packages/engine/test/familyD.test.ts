import { describe, expect, it } from "vitest";
import { anniversaryInPeriod, runChecks } from "../src/index.js";
import { base, emp, request } from "./fixtures.js";
import type { RunInput } from "../src/types.js";

const codes = (i: RunInput) => runChecks(i).exceptions.map((e) => e.checkCode);
const hits = (i: RunInput, code: string) => runChecks(i).exceptions.filter((e) => e.checkCode === code);

describe("D1 platform blockers", () => {
  it("fails: every blocker, resolved to the profile employee", () => {
    const i = base();
    i.draft.blockers = [
      { code: "missing_ssn", message: "Employee is missing an SSN", employeeId: "g_1003" },
      { code: "bank_unverified", message: "Company bank account not verified" },
    ];
    const h = hits(i, "D1");
    expect(h).toHaveLength(2);
    expect(h.find((x) => x.actual.startsWith("missing_ssn"))?.employeeName).toBe("Tom Hale");
    expect(h.find((x) => x.actual.startsWith("bank_unverified"))?.employeeName).toBeUndefined();
  });
  it("passes with none", () => {
    expect(codes(base())).toEqual([]);
  });
});

describe("D2 scheduled items", () => {
  it("fails: anniversary step increase with no request; passes with one", () => {
    const i = base();
    const f = i.profile.employees.find((e) => e.id === "e_fac")!;
    f.hireDate = "2024-11-10";
    f.anniversaryStepIncrease = true;
    expect(codes(i)).toEqual(["D2"]);
    expect(hits(i, "D2")[0]?.expected).toContain("2026-11-10");
    i.ledger = [request({ type: "rate_change", employeeId: "e_fac", effectiveDate: "2026-11-10", payload: { kind: "rate_change", newRateCents: 2200 } })];
    expect(codes(i)).toEqual([]);
  });
  it("anniversary: the hire year itself is not an anniversary, and Feb 29 is observed on Feb 28", () => {
    expect(anniversaryInPeriod("2026-11-10", "2026-11-01", "2026-11-15")).toBeUndefined();
    expect(anniversaryInPeriod("2024-02-29", "2026-02-16", "2026-02-28")).toBe("2026-02-28");
    expect(anniversaryInPeriod("2024-02-29", "2028-02-16", "2028-02-29")).toBe("2028-02-29");
    expect(anniversaryInPeriod("2020-12-30", "2026-12-16", "2027-01-05")).toBe("2026-12-30");
  });
  it("fails: housing designation expiring within 60 days (boundary 60 in, 61 out)", () => {
    const i = base();
    i.profile.housingAllowances[0]!.effectiveTo = "2027-01-17"; // 60 days from 2026-11-18
    expect(codes(i)).toEqual(["D2"]);
    i.profile.housingAllowances[0]!.effectiveTo = "2027-01-18";
    expect(codes(i)).toEqual([]);
  });
  it("passes: a housing_change request for the renewal is on the ledger", () => {
    const i = base();
    i.profile.housingAllowances[0]!.effectiveTo = "2026-12-31";
    i.ledger = [request({ type: "housing_change", employeeId: "e_pastor", effectiveDate: "2027-01-01", payload: { kind: "housing_change", annualAmountCents: 3600000, perPeriodAmountCents: 150000, resolutionDate: "2026-12-10" } })];
    expect(codes(i)).toEqual([]);
  });
  it("fails: benefit eligibility reached with no election", () => {
    const i = base();
    i.profile.employees.find((e) => e.id === "e_fac")!.benefitEligibilityDate = "2026-11-05";
    expect(codes(i)).toEqual(["D2"]);
  });
  it("review: accrual cap newly reached; silent once already at cap last period", () => {
    const i = base();
    emp(i.draft, "g_1002").timeOffBalanceHours = 120;
    emp(i.prior!, "g_1002").timeOffBalanceHours = 116;
    expect(hits(i, "D2")).toHaveLength(1);
    expect(hits(i, "D2")[0]?.severity).toBe("review");
    emp(i.prior!, "g_1002").timeOffBalanceHours = 120;
    expect(codes(i)).toEqual([]);
  });
  it("ignores inactive employees", () => {
    const i = base();
    const f = i.profile.employees.find((e) => e.id === "e_fac")!;
    f.benefitEligibilityDate = "2026-11-05";
    f.status = "leave";
    expect(codes(i)).toEqual([]);
  });
});
