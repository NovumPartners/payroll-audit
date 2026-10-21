import { describe, expect, it } from "vitest";
import { runChecks } from "@payroll-qa/engine";
import { annualizeRate, classifyEarning, mapGustoPayroll, sumHousing, type GustoContext } from "../src/gusto/map.js";
import { JotFormMapper, normalizeDate, verifySharedSecret } from "../src/jotform/index.js";
import { parseCsv, parseRipplingRegister } from "../src/rippling/index.js";

function ministerCtx(): GustoContext {
  return {
    companyId: "co_1",
    pulledAt: "2026-11-18T06:00:00Z",
    payroll: {
      payroll_uuid: "pr_1",
      processed: false,
      pay_period: { start_date: "2026-11-01", end_date: "2026-11-15", pay_schedule_uuid: "ps_1" },
      check_date: "2026-11-20",
      employee_compensations: [
        {
          employee_uuid: "emp_1",
          gross_pay: "5500.00",
          net_pay: "5500.00",
          fixed_compensations: [
            { name: "Regular Pay", amount: "4000.00" },
            { name: "Minister Housing Allowance", amount: "1500.00" },
          ],
          benefits: [{ name: "403(b)", employee_deduction: "125.00", company_contribution: "75.00", company_benefit_uuid: "cb_403b" }],
          deductions: [{ name: "Child support", amount: "200.00" }],
          taxes: [{ name: "Federal Income Tax", employer: false, amount: "0.00" }],
        },
      ],
    },
    employees: [{ uuid: "emp_1", first_name: "Daniel", last_name: "Reyes", jobs: [{ uuid: "job_1", primary: true, location_uuid: "loc_1", current_compensation_uuid: "comp_1", compensations: [{ uuid: "comp_1", rate: "96000.00", payment_unit: "Year" }] }] }],
    paySchedules: [{ uuid: "ps_1", frequency: "Twice per month" }],
    locations: [{ uuid: "loc_1", state: "TX" }],
    blockers: [],
    earningTypes: [{ name: "Minister Housing Allowance", uuid: "et_1", taxable: false }],
    companyBenefits: [{ uuid: "cb_403b", description: "403(b)", benefit_type: 7, pretax: true, posttax: false, imputed: false }],
    taxRequirements: [{ state: "TX", setup_complete: true }, { state: "OK", setup_complete: false }],
    ytdHousingByEmployee: { emp_1: 3000000 },
  };
}

describe("Gusto mapper", () => {
  it("normalizes a minister with housing, benefits, a post-tax deduction and a FICA-exempt tax set", () => {
    const d = mapGustoPayroll(ministerCtx());
    expect(d.payFrequency).toBe("semimonthly");
    expect(d.platformHousingEarningExcluded).toBe(true);
    const e = d.employees[0]!;
    expect(e.name).toBe("Daniel Reyes");
    expect(e.rateCents).toBe(9600000);
    expect(e.earnings).toEqual([
      { type: "regular", amountCents: 400000, excludedFromTaxableWages: undefined },
      { type: "housing_allowance", amountCents: 150000, excludedFromTaxableWages: true },
    ]);
    expect(e.deductions).toEqual([
      { planId: "cb_403b", name: "403(b)", employeeCents: 12500, employerCents: 7500, preTax: true },
      { name: "Child support", employeeCents: 20000, employerCents: 0, preTax: false },
    ]);
    expect(e.taxes.socialSecurityEmployeeCents).toBe(0);
    expect(e.workState).toBe("TX");
    expect(e.ytdHousingCents).toBe(3000000);
    expect(d.stateTaxSetup).toEqual(["TX"]); // OK is not set up; locations are not registrations
  });

  it("leaves tax treatment, year-to-date housing and tax setup undefined when the platform did not report them", () => {
    const ctx = ministerCtx();
    ctx.companyBenefits = undefined;
    ctx.taxRequirements = undefined;
    ctx.ytdHousingByEmployee = undefined;
    ctx.earningTypes = [{ name: "Minister Housing Allowance", uuid: "et_1" }];
    const d = mapGustoPayroll(ctx);
    expect(d.employees[0]!.deductions[0]!.preTax).toBeUndefined();
    expect(d.employees[0]!.ytdHousingCents).toBeUndefined();
    expect(d.stateTaxSetup).toBeUndefined();
    expect(d.platformHousingEarningExcluded).toBeUndefined();
  });

  it("reads the newer ready_to_run_payroll flag as well as setup_complete", () => {
    const ctx = ministerCtx();
    ctx.taxRequirements = [{ state: "TX", ready_to_run_payroll: true }, { state: "CA", ready_to_run_payroll: false }];
    expect(mapGustoPayroll(ctx).stateTaxSetup).toEqual(["TX"]);
  });

  it("annualizes every payment unit", () => {
    expect(annualizeRate({ uuid: "c", rate: "22.50", payment_unit: "Hour" }, "semimonthly")).toEqual({ payType: "hourly", rateCents: 2250 });
    expect(annualizeRate({ uuid: "c", rate: "5000", payment_unit: "Month" }, "semimonthly")).toEqual({ payType: "salary", rateCents: 6000000 });
    expect(annualizeRate({ uuid: "c", rate: "1000", payment_unit: "Week" }, "weekly")).toEqual({ payType: "salary", rateCents: 5200000 });
    expect(annualizeRate({ uuid: "c", rate: "2500", payment_unit: "Paycheck" }, "semimonthly")).toEqual({ payType: "salary", rateCents: 6000000 });
    expect(annualizeRate({ uuid: "c", rate: "2500", payment_unit: "Paycheck" }, "biweekly")).toEqual({ payType: "salary", rateCents: 6500000 });
    expect(annualizeRate(undefined, "monthly")).toEqual({ payType: "salary", rateCents: 0 });
  });

  it("classifies earning names onto the engine vocabulary", () => {
    expect(classifyEarning("Regular Pay")).toBe("regular");
    expect(classifyEarning("Salary")).toBe("regular");
    expect(classifyEarning("Double Overtime")).toBe("overtime");
    expect(classifyEarning("Clergy Housing Allowance")).toBe("housing_allowance");
    expect(classifyEarning("Parsonage")).toBe("housing_allowance");
    expect(classifyEarning("Year-End Bonus")).toBe("bonus");
    expect(classifyEarning("Holiday Pay")).toBe("holiday");
    expect(classifyEarning("Cell Phone Stipend")).toBe("cell_phone_stipend");
  });

  it("fails loudly on an unknown frequency or a missing pay schedule instead of defaulting", () => {
    const ctx = ministerCtx();
    ctx.paySchedules = [{ uuid: "ps_1", frequency: "Quarterly" as never }];
    expect(() => mapGustoPayroll(ctx)).toThrow(/frequency not recognised/);
    ctx.paySchedules = [{ uuid: "other", frequency: "Monthly" }, { uuid: "other2", frequency: "Monthly" }];
    expect(() => mapGustoPayroll(ctx)).toThrow(/pay schedule ps_1 not found/);
  });

  it("maps hourly compensation, overtime multipliers, PTO hours and payouts", () => {
    const ctx = ministerCtx();
    ctx.employees = [{ uuid: "emp_1", first_name: "Tom", last_name: "Hale", jobs: [{ uuid: "j", primary: true, location_uuid: "loc_1", current_compensation_uuid: "c", compensations: [{ uuid: "c", rate: "22.00", payment_unit: "Hour" }] }] }];
    ctx.payroll.employee_compensations = [{
      employee_uuid: "emp_1", gross_pay: "2101.00", net_pay: "1800.00",
      hourly_compensations: [{ name: "Regular Hours", hours: "80", compensation_multiplier: 1 }, { name: "Overtime", hours: "5", compensation_multiplier: 1.5 }],
      paid_time_off: [{ name: "Vacation Hours", hours: "8", final_payout_unused_hours_input: "0" }],
    }];
    const e = mapGustoPayroll(ctx).employees[0]!;
    expect(e.payType).toBe("hourly");
    expect(e.hours).toBe(85);
    expect(e.earnings).toEqual([
      { type: "regular", amountCents: 176000, hours: 80 },
      { type: "overtime", amountCents: 16500, hours: 5 },
      { type: "pto", amountCents: 17600, hours: 8 },
    ]);
  });

  it("sums year-to-date housing by employee across processed payrolls", () => {
    const p = ministerCtx().payroll;
    expect(sumHousing([p, { ...p, payroll_uuid: "pr_0" }])).toEqual({ emp_1: 300000 });
  });
});

describe("Rippling CSV", () => {
  it("parses quoted fields and builds employees; tax treatment comes from its column or stays unknown", () => {
    const register = [
      "Employee ID,Employee Name,Line Type,Line Name,Amount,Hours,Employer Amount,Tax Treatment",
      '1003,"Hale, Tom",Earning,Regular,"1,760.00",80,,',
      "1003,\"Hale, Tom\",Tax,Social Security,109.12,,,",
      "1003,\"Hale, Tom\",Tax,Employer Social Security,109.12,,,",
      "1003,\"Hale, Tom\",Deduction,Dental,30.00,,0.00,Pre-tax",
      "1003,\"Hale, Tom\",Deduction,Roth 403(b),50.00,,25.00,",
      "1003,\"Hale, Tom\",Net,Net Pay,1570.88,,,",
      "1001,Reyes Daniel,Earning,Clergy Housing,1500.00,,,",
    ].join("\r\n");
    const roster = ["Employee ID,Pay Type,Rate,Work State,PTO Balance (hours),YTD Housing Allowance", "1003,Hourly,22.00,TX,40,", "1001,Salary,\"96,000\",TX,,\"30,000.00\""].join("\n");
    const d = parseRipplingRegister(register, roster, {
      clientId: "r_1", platformPayrollId: "x", period: { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" }, payFrequency: "semimonthly", pulledAt: "now",
    });
    expect(d.employees.map((e) => e.platformEmployeeId)).toEqual(["1001", "1003"]); // sorted by id
    const e = d.employees[1]!;
    expect(e.name).toBe("Hale, Tom");
    expect(e.payType).toBe("hourly");
    expect(e.hours).toBe(80);
    expect(e.grossCents).toBe(176000);
    expect(e.netCents).toBe(157088);
    expect(e.taxes.socialSecurityEmployerCents).toBe(10912);
    expect(e.deductions.map((x) => x.preTax)).toEqual([true, undefined]);
    expect(e.timeOffBalanceHours).toBe(40);
    const m = d.employees[0]!;
    expect(m.earnings[0]).toEqual({ type: "housing_allowance", amountCents: 150000, hours: undefined });
    expect(m.ytdHousingCents).toBe(3000000);
    expect(m.rateCents).toBe(9600000);
    expect(d.stateTaxSetup).toBeUndefined();
    expect(parseCsv('a,b\n"x, y","q""r"')[0]).toEqual({ a: "x, y", b: 'q"r' });
  });

  it("computes net from the lines only when no net line is present, and reads parenthesised negatives", () => {
    const register = ["Employee ID,Employee Name,Line Type,Line Name,Amount,Hours,Employer Amount", "1,A,Earning,Regular,1000.00,,", "1,A,Tax,Federal Income Tax,100.00,,", "1,A,Earning,Correction,(50.00),,"].join("\n");
    const roster = ["Employee ID,Pay Type,Rate,Work State", "1,Salary,24000,TX"].join("\n");
    const e = parseRipplingRegister(register, roster, { clientId: "r", platformPayrollId: "x", period: { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" }, payFrequency: "semimonthly", pulledAt: "now" }).employees[0]!;
    expect(e.grossCents).toBe(95000);
    expect(e.netCents).toBe(85000);
  });
});

describe("JotForm mapper", () => {
  const maps = [{
    formId: "240001", type: "rate_change" as const, clientKey: "q2_client", employeeKey: "q3_employee", effectiveDateKey: "q5_effectiveDate", submittedByKey: "q1_email",
    fields: { newRate: "q4_newAnnualSalary" },
  }];
  const resolve = { clientId: (k: string) => (k === "Grace Fellowship" ? "c_grace" : undefined), employeeId: (_c: string, k: string) => (k === "Maria Soto" ? "e_admin" : undefined) };

  it("maps a rate change form to a change request", () => {
    const mapper = new JotFormMapper(maps, resolve);
    const cr = mapper.toChangeRequest({
      formID: "240001", submissionID: "9001", created_at: "2026-10-28 15:00:00",
      rawRequest: JSON.stringify({ q1_email: "admin@grace.example", q2_client: "Grace Fellowship", q3_employee: "Maria Soto", q4_newAnnualSalary: "$63,000.00", q5_effectiveDate: { month: "11", day: "1", year: "2026" } }),
    });
    expect(cr).toMatchObject({ id: "jf_9001", clientId: "c_grace", employeeId: "e_admin", type: "rate_change", effectiveDate: "2026-11-01", status: "received", submittedAt: "2026-10-28T15:00:00.000Z", payload: { kind: "rate_change", newRateCents: 6300000 } });
  });

  it("rejects an unknown employee, an unknown client, a blank amount, and an impossible date instead of guessing", () => {
    const mapper = new JotFormMapper(maps, resolve);
    const sub = (over: Record<string, unknown>) => ({ formID: "240001", submissionID: "2", rawRequest: { q1_email: "a", q2_client: "Grace Fellowship", q3_employee: "Maria Soto", q4_newAnnualSalary: "1", q5_effectiveDate: "11/01/2026", ...over } });
    expect(() => mapper.toChangeRequest(sub({ q3_employee: "nobody" }))).toThrow(/Unknown employee/);
    expect(() => mapper.toChangeRequest(sub({ q2_client: "Nobody Church" }))).toThrow(/Unknown client/);
    expect(() => mapper.toChangeRequest(sub({ q4_newAnnualSalary: "" }))).toThrow(/blank/);
    expect(() => mapper.toChangeRequest(sub({ q4_newAnnualSalary: "abc" }))).toThrow(/not a number/);
    expect(() => mapper.toChangeRequest(sub({ q5_effectiveDate: "02/30/2026" }))).toThrow(/Invalid calendar date/);
    expect(() => mapper.toChangeRequest({ formID: "999", submissionID: "1", rawRequest: {} })).toThrow(/No field map/);
  });

  it("normalizes every date shape JotForm sends", () => {
    expect(normalizeDate({ month: "2", day: "9", year: "2026" })).toBe("2026-02-09");
    expect(normalizeDate("2/9/2026")).toBe("2026-02-09");
    expect(normalizeDate("2026-02-09 10:00:00")).toBe("2026-02-09");
  });

  it("verifies the shared secret in constant time and refuses blanks", () => {
    expect(verifySharedSecret("abc", "abc")).toBe(true);
    expect(verifySharedSecret("abd", "abc")).toBe(false);
    expect(verifySharedSecret("ab", "abc")).toBe(false);
    expect(verifySharedSecret(undefined, "abc")).toBe(false);
    expect(verifySharedSecret("abc", undefined)).toBe(false);
    expect(verifySharedSecret("", "")).toBe(false);
  });
});

describe("end to end", () => {
  it("a Gusto draft with no profile deviations passes the engine", () => {
    const ctx: GustoContext = {
      companyId: "co_1", pulledAt: "now",
      payroll: { payroll_uuid: "pr", processed: false, pay_period: { start_date: "2026-11-01", end_date: "2026-11-15" }, check_date: "2026-11-20", employee_compensations: [{ employee_uuid: "e1", gross_pay: "2500", net_pay: "1800", fixed_compensations: [{ name: "Regular", amount: "2500" }], taxes: [{ name: "Social Security", employer: false, amount: "155" }] }] },
      employees: [{ uuid: "e1", first_name: "M", last_name: "S", jobs: [{ uuid: "j", primary: true, location_uuid: "l", current_compensation_uuid: "c", compensations: [{ uuid: "c", rate: "60000", payment_unit: "Year" }] }] }],
      paySchedules: [{ uuid: "p", frequency: "Twice per month" }], locations: [{ uuid: "l", state: "TX" }], blockers: [],
      taxRequirements: [{ state: "TX", setup_complete: true }],
    };
    const draft = mapGustoPayroll(ctx);
    const r = runChecks({
      asOf: "2026-11-18", ledger: [], draft,
      profile: { clientId: "co_1", clientName: "T", platform: "gusto", payFrequency: "semimonthly", registeredStates: ["TX"], housingAllowances: [], benefitElections: [], timeOffPolicies: [],
        employees: [{ id: "x", platformEmployeeId: "e1", name: "M S", status: "active", hireDate: "2020-01-01", payType: "salary", rateCents: 6000000, rateEffectiveDate: "2026-01-01", standardHours: 0, workState: "TX", isMinister: false, ficaExempt: false, fedWithholdingVoluntary: true }] },
    });
    expect(r.verdict).toBe("pass");
    expect(r.exceptions).toEqual([]);
  });
});
