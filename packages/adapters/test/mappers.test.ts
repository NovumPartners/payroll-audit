import { describe, expect, it } from "vitest";
import { runChecks } from "@payroll-qa/engine";
import { mapGustoPayroll, type GustoContext } from "../src/gusto/map.js";
import { JotFormMapper } from "../src/jotform/index.js";
import { parseCsv, parseRipplingRegister } from "../src/rippling/index.js";

describe("Gusto mapper", () => {
  it("normalizes a minister with housing and a FICA-exempt tax set", () => {
    const ctx: GustoContext = {
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
            taxes: [{ name: "Federal Income Tax", employer: false, amount: "0.00" }],
          },
        ],
      },
      employees: [{ uuid: "emp_1", first_name: "Daniel", last_name: "Reyes", jobs: [{ uuid: "job_1", primary: true, location_uuid: "loc_1", current_compensation_uuid: "comp_1", compensations: [{ uuid: "comp_1", rate: "96000.00", payment_unit: "Year" }] }] }],
      paySchedules: [{ uuid: "ps_1", frequency: "Twice per month" }],
      locations: [{ uuid: "loc_1", state: "TX" }],
      blockers: [],
      earningTypes: [{ name: "Minister Housing Allowance", uuid: "et_1", taxable: false }],
    };
    const d = mapGustoPayroll(ctx);
    expect(d.payFrequency).toBe("semimonthly");
    expect(d.platformHousingEarningExcluded).toBe(true);
    const e = d.employees[0]!;
    expect(e.name).toBe("Daniel Reyes");
    expect(e.rateCents).toBe(9600000);
    expect(e.earnings.find((x) => x.type === "housing_allowance")?.amountCents).toBe(150000);
    expect(e.taxes.socialSecurityEmployeeCents).toBe(0);
    expect(e.workState).toBe("TX");
    expect(d.stateTaxSetup).toEqual(["TX"]);
  });
});

describe("Rippling CSV", () => {
  it("parses quoted fields and builds employees", () => {
    const register = [
      "Employee ID,Employee Name,Line Type,Line Name,Amount,Hours,Employer Amount",
      '1003,"Hale, Tom",Earning,Regular,1760.00,80,',
      "1003,\"Hale, Tom\",Tax,Social Security,109.12,,",
      "1003,\"Hale, Tom\",Tax,Employer Social Security,109.12,,",
      "1003,\"Hale, Tom\",Deduction,Dental,30.00,,0.00",
    ].join("\n");
    const roster = ["Employee ID,Pay Type,Rate,Work State,PTO Balance (hours)", "1003,Hourly,22.00,TX,40"].join("\n");
    const d = parseRipplingRegister(register, roster, {
      clientId: "r_1", platformPayrollId: "x", period: { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" }, payFrequency: "semimonthly", registeredStates: ["TX"], pulledAt: "now",
    });
    const e = d.employees[0]!;
    expect(e.name).toBe("Hale, Tom");
    expect(e.payType).toBe("hourly");
    expect(e.hours).toBe(80);
    expect(e.grossCents).toBe(176000);
    expect(e.taxes.socialSecurityEmployerCents).toBe(10912);
    expect(e.deductions[0]?.employeeCents).toBe(3000);
    expect(e.timeOffBalanceHours).toBe(40);
    expect(parseCsv('a,b\n"x, y","q""r"')[0]).toEqual({ a: "x, y", b: 'q"r' });
  });
});

describe("JotForm mapper", () => {
  it("maps a rate change form to a change request", () => {
    const mapper = new JotFormMapper(
      [{
        formId: "240001", type: "rate_change", clientKey: "q2_client", employeeKey: "q3_employee", effectiveDateKey: "q5_effectiveDate", submittedByKey: "q1_email",
        fields: { newRate: "q4_newAnnualSalary" },
      }],
      { clientId: (k) => (k === "Grace Fellowship" ? "c_grace" : k), employeeId: (_c, k) => (k === "Maria Soto" ? "e_admin" : undefined) },
    );
    const cr = mapper.toChangeRequest({
      formID: "240001", submissionID: "9001", created_at: "2026-10-28 15:00:00",
      rawRequest: JSON.stringify({ q1_email: "admin@grace.example", q2_client: "Grace Fellowship", q3_employee: "Maria Soto", q4_newAnnualSalary: "$63,000.00", q5_effectiveDate: { month: "11", day: "1", year: "2026" } }),
    });
    expect(cr).toMatchObject({ id: "jf_9001", clientId: "c_grace", employeeId: "e_admin", type: "rate_change", effectiveDate: "2026-11-01", status: "received", payload: { kind: "rate_change", newRateCents: 6300000 } });
  });

  it("rejects an unknown employee instead of guessing", () => {
    const mapper = new JotFormMapper(
      [{ formId: "1", type: "rate_change", clientKey: "c", employeeKey: "e", effectiveDateKey: "d", submittedByKey: "s", fields: { newRate: "r" } }],
      { clientId: (k) => k, employeeId: () => undefined },
    );
    expect(() => mapper.toChangeRequest({ formID: "1", submissionID: "2", rawRequest: { c: "x", e: "nobody", d: "2026-11-01", s: "a", r: "1" } })).toThrow(/Unknown employee/);
  });
});

describe("end to end", () => {
  it("a Gusto draft with no profile deviations passes the engine", () => {
    const ctx: GustoContext = {
      companyId: "co_1", pulledAt: "now",
      payroll: { payroll_uuid: "pr", processed: false, pay_period: { start_date: "2026-11-01", end_date: "2026-11-15" }, check_date: "2026-11-20", employee_compensations: [{ employee_uuid: "e1", gross_pay: "2500", net_pay: "1800", fixed_compensations: [{ name: "Regular", amount: "2500" }], taxes: [{ name: "Social Security", employer: false, amount: "155" }] }] },
      employees: [{ uuid: "e1", first_name: "M", last_name: "S", jobs: [{ uuid: "j", primary: true, location_uuid: "l", current_compensation_uuid: "c", compensations: [{ uuid: "c", rate: "60000", payment_unit: "Year" }] }] }],
      paySchedules: [{ uuid: "p", frequency: "Twice per month" }], locations: [{ uuid: "l", state: "TX" }], blockers: [],
    };
    const draft = mapGustoPayroll(ctx);
    const r = runChecks({
      asOf: "2026-11-18", ledger: [], draft,
      profile: { clientId: "co_1", clientName: "T", platform: "gusto", payFrequency: "semimonthly", registeredStates: ["TX"], housingAllowances: [], benefitElections: [], timeOffPolicies: [],
        employees: [{ id: "x", platformEmployeeId: "e1", name: "M S", status: "active", hireDate: "2020-01-01", payType: "salary", rateCents: 6000000, rateEffectiveDate: "2026-01-01", standardHours: 0, workState: "TX", isMinister: false, ficaExempt: false, fedWithholdingVoluntary: true }] },
    });
    expect(r.verdict).toBe("pass");
  });
});
