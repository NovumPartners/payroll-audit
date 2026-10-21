/**
 * Normalized schema. Every adapter (Gusto, Rippling, future platforms) maps
 * into these shapes. The reconciliation engine never sees platform-specific
 * payloads. Money is in cents (integer) to avoid float drift.
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
  standardHours: number; // per period for hourly, used for B3
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
  | { kind: "new_hire"; payType: PayType; rateCents: number; hireDate: string }
  | { kind: "termination"; terminationDate: string; payoutAccruedTimeOff: boolean }
  | { kind: "rate_change"; newRateCents: number }
  | { kind: "housing_change"; annualAmountCents: number; perPeriodAmountCents: number; resolutionDate: string }
  | { kind: "benefit_change"; planId: string; employeeDeductionCents: number; employerContributionCents: number }
  | { kind: "time_off_change"; policyName: string; accrualRateHours: number; capHours?: number }
  | { kind: "one_time_pay"; earningType: string; amountCents: number; description?: string }
  | { kind: "deduction_change"; deductionName: string; amountCents: number }
  | { kind: "schedule_change"; payFrequency: PayFrequency };

// ---------- Normalized platform draft ----------

export interface EarningLine {
  type: string; // "regular" | "overtime" | "bonus" | "housing_allowance" | "retro" | "commission" | custom
  amountCents: number;
  hours?: number;
  excludedFromTaxableWages?: boolean;
}

export interface DeductionLine {
  planId?: string;
  name: string;
  employeeCents: number;
  employerCents: number;
  preTax: boolean;
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
  ytdHousingCents?: number;
  timeOffBalanceHours?: number;
  periodStart?: string; // for proration checks on hires/terms
  periodEnd?: string;
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
  platformHousingEarningExcluded?: boolean; // C4: earning type config
  platformAccruals?: Record<string, { rateHours: number; capHours?: number }>; // by policy name, C6
  stateTaxSetup?: string[]; // states configured on platform, C8
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

export interface EngineConfig {
  grossMovePct: number; // B1
  grossMoveMinCents: number; // B1
  hoursMultiplier: number; // B3
  hoursHardCap: number; // B3
  netDropPct: number; // B6
  clientGrossMovePct: number; // B7
  accrualToleranceHours: number; // C6
  housingExpiryWarnDays: number; // D2
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
}

export interface CheckContext extends RunInput {
  config: EngineConfig;
  profileByPlatformId: Map<string, ProfileEmployee>;
  draftByPlatformId: Map<string, DraftEmployee>;
  priorByPlatformId: Map<string, DraftEmployee>;
  ledgerInPeriod: ChangeRequest[]; // effective inside draft period
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
  };
}
