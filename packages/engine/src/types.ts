/**
 * Normalized schema. Every adapter (Gusto, Rippling, future platforms) maps
 * into these shapes. The reconciliation engine never sees platform-specific
 * payloads. Money is in integer cents to avoid float drift. Dates are ISO
 * `YYYY-MM-DD` strings and compare lexicographically.
 *
 * The engine is a pure function of RunInput: no clock, no network, no
 * randomness. `asOf` is always passed in.
 */

export type Platform = "gusto" | "rippling";
export type PayType = "salary" | "hourly";
export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";
export type Severity = "block" | "review" | "info";

export type ChangeType =
  | "new_hire"
  | "termination"
  | "rate_change"
  | "housing_change"
  | "benefit_change"
  | "time_off_change"
  | "one_time_pay"
  | "deduction_change"
  | "schedule_change";

export type ChangeStatus =
  | "received"
  | "applied_to_profile"
  | "verified_in_platform"
  | "rejected";

export interface Period {
  start: string; // ISO date, inclusive
  end: string; // ISO date, inclusive
  payDate: string;
}

// ---------- Payroll Profile (signed source of truth) ----------

export interface ProfileEmployee {
  id: string;
  platformEmployeeId: string;
  name: string;
  status: "active" | "terminated" | "leave";
  hireDate: string;
  terminationDate?: string;
  payType: PayType;
  rateCents: number; // annual salary cents for salary; hourly cents for hourly
  rateEffectiveDate: string;
  standardHours: number; // hours per pay period for hourly (0 for salary); used by B3 and C1
  workState: string;
  isMinister: boolean;
  ficaExempt: boolean;
  fedWithholdingVoluntary: boolean;
  anniversaryStepIncrease?: boolean;
  benefitEligibilityDate?: string;
}

export interface HousingAllowance {
  employeeId: string;
  annualAmountCents: number;
  perPeriodAmountCents: number;
  resolutionDate: string;
  resolutionDocId?: string;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface BenefitElection {
  employeeId: string;
  planId: string;
  planName: string;
  employeeDeductionCents: number;
  employerContributionCents: number;
  preTax: boolean;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface TimeOffPolicy {
  policyName: string;
  accrualRateHours: number; // hours accrued per accrual basis unit
  accrualBasis: "per_period" | "per_hour" | "annual_grant";
  capHours?: number;
  assignedEmployeeIds: string[];
}

export interface PayrollProfile {
  clientId: string;
  clientName: string;
  platform: Platform;
  payFrequency: PayFrequency;
  signedBy?: string;
  signedAt?: string;
  employees: ProfileEmployee[];
  housingAllowances: HousingAllowance[];
  benefitElections: BenefitElection[];
  timeOffPolicies: TimeOffPolicy[];
  registeredStates: string[];
  /**
   * Set by the specialist at signature after confirming in the platform's
   * settings that the housing allowance earning type is excluded from
   * taxable wages. Used by C4 when the platform pull cannot report it.
   */
  housingEarningTypeConfirmedExcluded?: boolean;
  /**
   * Days from period end to pay date under the client's pay schedule
   * (for example 5 for "paid the 5th and 20th for periods ending the last
   * and 15th"). When set, C7 checks the draft pay date against it, allowing
   * an earlier date by up to 3 days for weekend and holiday pull-forward.
   */
  expectedPayDateLagDays?: number;
}

// ---------- Change ledger ----------

export interface ChangeRequest {
  id: string;
  clientId: string;
  employeeId?: string;
  type: ChangeType;
  effectiveDate: string;
  status: ChangeStatus;
  submittedBy: string;
  submittedAt: string;
  jotformSubmissionId?: string;
  payload: ChangePayload;
}

export type ChangePayload =
  | {
      kind: "new_hire";
      payType: PayType;
      rateCents: number;
      hireDate: string;
      /** Carried from the form when it collects them; the profile row is created at apply time. */
      name?: string;
      workState?: string;
    }
  | { kind: "termination"; terminationDate: string; payoutAccruedTimeOff: boolean }
  | {
      kind: "rate_change";
      newRateCents: number;
      /**
       * The rate in force before the change, captured when the request is
       * applied to the profile (the profile then carries the new rate, so
       * the old one would otherwise be lost). A2 needs it to prorate a
       * mid-period change. Absent, A2 reports the proration as not
       * verifiable rather than guessing.
       */
      previousRateCents?: number;
    }
  | { kind: "housing_change"; annualAmountCents: number; perPeriodAmountCents: number; resolutionDate: string }
  | { kind: "benefit_change"; planId: string; employeeDeductionCents: number; employerContributionCents: number }
  | { kind: "time_off_change"; policyName: string; accrualRateHours: number; capHours?: number }
  | { kind: "one_time_pay"; earningType: string; amountCents: number; description?: string }
  | { kind: "deduction_change"; deductionName: string; amountCents: number }
  | { kind: "schedule_change"; payFrequency: PayFrequency };

// ---------- Normalized platform draft ----------

export interface EarningLine {
  type: string; // "regular" | "overtime" | "bonus" | "housing_allowance" | "retro" | "commission" | "pto" | "pto_payout" | custom
  amountCents: number;
  hours?: number;
  excludedFromTaxableWages?: boolean;
}

export interface DeductionLine {
  planId?: string;
  name: string;
  employeeCents: number;
  employerCents: number;
  /** undefined when the platform pull does not report tax treatment; C5 then reports it unverified. */
  preTax?: boolean;
}

export interface TaxLine {
  socialSecurityEmployeeCents: number;
  medicareEmployeeCents: number;
  socialSecurityEmployerCents: number;
  medicareEmployerCents: number;
  federalWithholdingCents: number;
  stateCode?: string;
}

export interface DraftEmployee {
  platformEmployeeId: string;
  name: string;
  payType: PayType;
  rateCents: number;
  hours: number; // total hours this period for hourly; 0 for salary
  earnings: EarningLine[];
  deductions: DeductionLine[];
  taxes: TaxLine;
  grossCents: number;
  netCents: number;
  workState: string;
  /** Platform-configured standard hours per period, when the platform exposes it (C1). */
  standardHours?: number;
  /** Housing allowance paid year to date BEFORE this run. undefined when the platform does not report it. */
  ytdHousingCents?: number;
  timeOffBalanceHours?: number;
  periodStart?: string; // first paid day when the platform exposes it (hires and terminations)
  periodEnd?: string; // last paid day when the platform exposes it
}

export interface PlatformBlocker {
  code: string;
  message: string;
  employeeId?: string;
}

export interface DraftRun {
  clientId: string;
  platform: Platform;
  platformPayrollId: string;
  period: Period;
  payFrequency: PayFrequency;
  employees: DraftEmployee[];
  blockers: PlatformBlocker[];
  /** C4: whether the housing earning type is configured as excluded from taxable wages. undefined when the platform cannot report it. */
  platformHousingEarningExcluded?: boolean;
  /** C6: accrual policies as configured on the platform, by policy name. undefined when the platform does not report them. */
  platformAccruals?: Record<string, { rateHours: number; capHours?: number }>;
  /** C8: states with tax setup complete on the platform. undefined when not reported; the profile's registered states are used alone. */
  stateTaxSetup?: string[];
  pulledAt: string;
}

// ---------- Engine input and output ----------

export interface RunInput {
  profile: PayrollProfile;
  ledger: ChangeRequest[];
  draft: DraftRun;
  prior?: DraftRun;
  asOf: string; // ISO date the check runs
  config?: Partial<EngineConfig>;
}

export type ProrationMethod = "calendar_days" | "work_days";

export interface EngineConfig {
  grossMovePct: number; // B1: fraction of prior recurring gross
  grossMoveMinCents: number; // B1: floor in cents
  hoursMultiplier: number; // B3: multiple of standard hours
  hoursHardCap: number; // B3: hours per BIWEEKLY period; scaled to the pay frequency
  netDropPct: number; // B6: fraction of prior net
  clientGrossMovePct: number; // B7
  accrualToleranceHours: number; // C6: fallback tolerance when a policy accrues nothing per period
  housingExpiryWarnDays: number; // D2
  prorationMethod: ProrationMethod; // A2, A3, A4, C1: how the platform prorates a partial period
  prorationToleranceCents: number; // A2, A3, A4, C1: rounding allowance on a computed amount
  payDateEarlyToleranceDays: number; // C7: weekend/holiday pull-forward allowance
}

export const DEFAULT_CONFIG: EngineConfig = {
  grossMovePct: 0.02,
  grossMoveMinCents: 5000,
  hoursMultiplier: 1.5,
  hoursHardCap: 80,
  netDropPct: 0.5,
  clientGrossMovePct: 0.05,
  accrualToleranceHours: 8,
  housingExpiryWarnDays: 60,
  prorationMethod: "calendar_days",
  prorationToleranceCents: 100,
  payDateEarlyToleranceDays: 3,
};

export type ExpectedSource = "profile" | "ledger" | "prior_run" | "platform_rule";

export interface Exception {
  checkCode: string;
  severity: Severity;
  employeeId?: string;
  employeeName?: string;
  expected: string;
  actual: string;
  sourceOfExpected: ExpectedSource;
  description: string;
  /** The ledger request this exception is about, when there is one. */
  requestId?: string;
}

export interface CheckContext extends RunInput {
  config: EngineConfig;
  profileByPlatformId: Map<string, ProfileEmployee>;
  profileById: Map<string, ProfileEmployee>;
  draftByPlatformId: Map<string, DraftEmployee>;
  priorByPlatformId: Map<string, DraftEmployee>;
  /** Non-rejected requests for this client effective inside the draft period. */
  ledgerInPeriod: ChangeRequest[];
  /** Non-rejected requests for this client, any effective date. */
  ledgerActive: ChangeRequest[];
  housingByEmployee: Map<string, HousingAllowance>;
  electionsByEmployee: Map<string, BenefitElection[]>;
}

export interface Check {
  code: string;
  family: "A" | "B" | "C" | "D";
  title: string;
  severity: Severity;
  run: (ctx: CheckContext) => Exception[];
}

/** One line of the client preview: who moved, by how much, and why. */
export interface Movement {
  employeeId?: string;
  employeeName: string;
  priorGrossCents?: number;
  grossCents?: number;
  deltaCents: number;
  reason: string;
}

export interface RunReport {
  clientId: string;
  clientName: string;
  platformPayrollId: string;
  period: Period;
  ranAt: string;
  verdict: "pass" | "exceptions";
  counts: { block: number; review: number; info: number };
  exceptions: Exception[];
  summary: {
    headcount: number;
    priorHeadcount?: number;
    totalGrossCents: number;
    priorTotalGrossCents?: number;
    totalNetCents: number;
    priorTotalNetCents?: number;
    movements: Movement[];
  };
}
