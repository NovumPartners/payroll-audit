/**
 * Anonymized fixture: a composite church on semimonthly payroll.
 * Three employees: a lead pastor (minister, housing allowance, FICA exempt),
 * a salaried administrator with benefits, and an hourly facilities worker with PTO.
 * The base scenario passes every check. Each test mutates one thing.
 */
import type { ChangeRequest, DraftEmployee, DraftRun, PayrollProfile, RunInput } from "../src/types.js";

export const PERIOD = { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" };
export const PRIOR_PERIOD = { start: "2026-10-16", end: "2026-10-31", payDate: "2026-11-05" };
export const AS_OF = "2026-11-18";

export function profile(): PayrollProfile {
  return {
    clientId: "c_grace",
    clientName: "Grace Fellowship (fixture)",
    platform: "gusto",
    payFrequency: "semimonthly",
    signedBy: "specialist@novumsp.com",
    signedAt: "2026-10-20",
    registeredStates: ["TX"],
    employees: [
      {
        id: "e_pastor",
        platformEmployeeId: "g_1001",
        name: "Pastor Daniel Reyes",
        status: "active",
        hireDate: "2019-03-01",
        payType: "salary",
        rateCents: 9600000, // $96,000 cash salary
        rateEffectiveDate: "2026-01-01",
        standardHours: 0,
        workState: "TX",
        isMinister: true,
        ficaExempt: true,
        fedWithholdingVoluntary: false,
      },
      {
        id: "e_admin",
        platformEmployeeId: "g_1002",
        name: "Maria Soto",
        status: "active",
        hireDate: "2022-06-13",
        payType: "salary",
        rateCents: 6000000, // $60,000
        rateEffectiveDate: "2026-01-01",
        standardHours: 0,
        workState: "TX",
        isMinister: false,
        ficaExempt: false,
        fedWithholdingVoluntary: true,
      },
      {
        id: "e_fac",
        platformEmployeeId: "g_1003",
        name: "Tom Hale",
        status: "active",
        hireDate: "2024-02-05",
        payType: "hourly",
        rateCents: 2200, // $22.00 per hour
        rateEffectiveDate: "2026-01-01",
        standardHours: 80, // semimonthly standard
        workState: "TX",
        isMinister: false,
        ficaExempt: false,
        fedWithholdingVoluntary: true,
      },
    ],
    housingAllowances: [
      {
        employeeId: "e_pastor",
        annualAmountCents: 3600000, // $36,000
        perPeriodAmountCents: 150000, // $1,500
        resolutionDate: "2025-12-10",
        resolutionDocId: "box_12345",
        effectiveFrom: "2026-01-01",
        effectiveTo: undefined,
      },
    ],
    benefitElections: [
      {
        employeeId: "e_admin",
        planId: "med_ppo",
        planName: "Medical PPO",
        employeeDeductionCents: 18000,
        employerContributionCents: 42000,
        preTax: true,
        effectiveFrom: "2026-01-01",
      },
      {
        employeeId: "e_admin",
        planId: "403b",
        planName: "403(b)",
        employeeDeductionCents: 12500,
        employerContributionCents: 7500,
        preTax: true,
        effectiveFrom: "2026-01-01",
      },
    ],
    timeOffPolicies: [
      {
        policyName: "PTO Standard",
        accrualRateHours: 4,
        accrualBasis: "per_period",
        capHours: 120,
        assignedEmployeeIds: ["e_admin", "e_fac"],
      },
    ],
  };
}

function pastor(): DraftEmployee {
  return {
    platformEmployeeId: "g_1001",
    name: "Pastor Daniel Reyes",
    payType: "salary",
    rateCents: 9600000,
    hours: 0,
    earnings: [
      { type: "regular", amountCents: 400000 },
      { type: "housing_allowance", amountCents: 150000, excludedFromTaxableWages: true },
    ],
    deductions: [],
    taxes: {
      socialSecurityEmployeeCents: 0,
      medicareEmployeeCents: 0,
      socialSecurityEmployerCents: 0,
      medicareEmployerCents: 0,
      federalWithholdingCents: 0,
      stateCode: "TX",
    },
    grossCents: 550000,
    netCents: 550000,
    workState: "TX",
    ytdHousingCents: 3000000, // 20 periods paid so far
  };
}

function admin(): DraftEmployee {
  return {
    platformEmployeeId: "g_1002",
    name: "Maria Soto",
    payType: "salary",
    rateCents: 6000000,
    hours: 0,
    earnings: [{ type: "regular", amountCents: 250000 }],
    deductions: [
      { planId: "med_ppo", name: "Medical PPO", employeeCents: 18000, employerCents: 42000, preTax: true },
      { planId: "403b", name: "403(b)", employeeCents: 12500, employerCents: 7500, preTax: true },
    ],
    taxes: {
      socialSecurityEmployeeCents: 13609,
      medicareEmployeeCents: 3183,
      socialSecurityEmployerCents: 13609,
      medicareEmployerCents: 3183,
      federalWithholdingCents: 24000,
      stateCode: "TX",
    },
    grossCents: 250000,
    netCents: 178708,
    workState: "TX",
    timeOffBalanceHours: 64,
  };
}

function facilities(hours = 80): DraftEmployee {
  const regular = 2200 * hours;
  return {
    platformEmployeeId: "g_1003",
    name: "Tom Hale",
    payType: "hourly",
    rateCents: 2200,
    hours,
    earnings: [{ type: "regular", amountCents: regular, hours }],
    deductions: [],
    taxes: {
      socialSecurityEmployeeCents: Math.round(regular * 0.062),
      medicareEmployeeCents: Math.round(regular * 0.0145),
      socialSecurityEmployerCents: Math.round(regular * 0.062),
      medicareEmployerCents: Math.round(regular * 0.0145),
      federalWithholdingCents: 12000,
      stateCode: "TX",
    },
    grossCents: regular,
    netCents: regular - Math.round(regular * 0.0765) - 12000,
    workState: "TX",
    timeOffBalanceHours: 40,
  };
}

export function draft(overrides: Partial<DraftRun> = {}): DraftRun {
  return {
    clientId: "c_grace",
    platform: "gusto",
    platformPayrollId: "pr_2026_11_15",
    period: PERIOD,
    payFrequency: "semimonthly",
    employees: [pastor(), admin(), facilities()],
    blockers: [],
    platformHousingEarningExcluded: true,
    platformAccruals: { "PTO Standard": { rateHours: 4, capHours: 120 } },
    stateTaxSetup: ["TX"],
    pulledAt: `${AS_OF}T06:00:00Z`,
    ...overrides,
  };
}

export function prior(): DraftRun {
  const p = draft({ platformPayrollId: "pr_2026_10_31", period: PRIOR_PERIOD, pulledAt: "2026-11-03T06:00:00Z" });
  // prior balances are one accrual behind
  for (const e of p.employees) {
    if (e.timeOffBalanceHours !== undefined) e.timeOffBalanceHours -= 4;
    if (e.ytdHousingCents !== undefined) e.ytdHousingCents -= 150000;
  }
  return p;
}

export function request(partial: Partial<ChangeRequest> & Pick<ChangeRequest, "payload" | "type">): ChangeRequest {
  return {
    id: partial.id ?? "cr_1",
    clientId: "c_grace",
    employeeId: partial.employeeId,
    type: partial.type,
    effectiveDate: partial.effectiveDate ?? "2026-11-01",
    status: partial.status ?? "applied_to_profile",
    submittedBy: "admin@gracefellowship.example",
    submittedAt: "2026-10-28T15:00:00Z",
    jotformSubmissionId: "jf_555",
    payload: partial.payload,
  };
}

export function base(): RunInput {
  return { profile: profile(), ledger: [], draft: draft(), prior: prior(), asOf: AS_OF };
}

/** Find the draft employee by platform id; throws if missing so fixtures fail loudly. */
export function emp(run: DraftRun, platformId: string): DraftEmployee {
  const e = run.employees.find((x) => x.platformEmployeeId === platformId);
  if (!e) throw new Error(`fixture employee ${platformId} missing`);
  return e;
}
