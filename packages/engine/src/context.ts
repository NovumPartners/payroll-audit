import {
  DEFAULT_CONFIG,
  type BenefitElection,
  type CheckContext,
  type ChangeRequest,
  type DraftEmployee,
  type EngineConfig,
  type HousingAllowance,
  type PayFrequency,
  type Period,
  type ProfileEmployee,
  type RunInput,
} from "./types";

export function inPeriod(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

export function activeOn(date: string, from: string, to?: string): boolean {
  return date >= from && (to === undefined || date <= to);
}

/** Whole days from a to b (b - a). ISO dates parse as UTC midnight, so no DST drift. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
}

/** Inclusive calendar-day count of a date range. */
export function calendarDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/** Inclusive Monday-to-Friday count of a date range. */
export function workDays(start: string, end: string): number {
  let n = 0;
  const last = Date.parse(end);
  for (let t = Date.parse(start); t <= last; t += 864e5) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 864e5).toISOString().slice(0, 10);
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

export function periodsPerYear(freq: PayFrequency): number {
  return PERIODS_PER_YEAR[freq];
}

/** Per-period salary from an annual rate. */
export function perPeriodSalary(annualCents: number, freq: PayFrequency): number {
  return Math.round(annualCents / periodsPerYear(freq));
}

/**
 * Earning types that recur every period for a salaried employee. B1 compares
 * these between periods; anything else is a one-time type and is B4's job.
 */
export const RECURRING_EARNING_TYPES = new Set(["regular", "overtime", "housing_allowance", "pto", "holiday", "sick"]);

/** Lines that together make up a salaried employee's base salary for the period. */
export const BASE_SALARY_TYPES = new Set(["regular", "pto", "holiday", "sick"]);

export function buildContext(input: RunInput): CheckContext {
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const profileByPlatformId = new Map<string, ProfileEmployee>();
  const profileById = new Map<string, ProfileEmployee>();
  for (const e of input.profile.employees) {
    profileByPlatformId.set(e.platformEmployeeId, e);
    profileById.set(e.id, e);
  }

  const draftByPlatformId = new Map<string, DraftEmployee>();
  for (const e of input.draft.employees) draftByPlatformId.set(e.platformEmployeeId, e);

  const priorByPlatformId = new Map<string, DraftEmployee>();
  for (const e of input.prior?.employees ?? []) priorByPlatformId.set(e.platformEmployeeId, e);

  const { start, end } = input.draft.period;
  const ledgerActive = input.ledger
    .filter((c) => c.clientId === input.profile.clientId && c.status !== "rejected")
    .slice()
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ledgerInPeriod: ChangeRequest[] = ledgerActive.filter((c) => inPeriod(c.effectiveDate, start, end));

  const housingByEmployee = new Map<string, HousingAllowance>();
  for (const h of input.profile.housingAllowances) {
    if (activeOn(end, h.effectiveFrom, h.effectiveTo)) housingByEmployee.set(h.employeeId, h);
  }

  const electionsByEmployee = new Map<string, BenefitElection[]>();
  for (const b of input.profile.benefitElections) {
    if (!activeOn(end, b.effectiveFrom, b.effectiveTo)) continue;
    const list = electionsByEmployee.get(b.employeeId) ?? [];
    list.push(b);
    electionsByEmployee.set(b.employeeId, list);
  }
  for (const list of electionsByEmployee.values()) list.sort((a, b) => (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));

  return {
    ...input,
    config,
    profileByPlatformId,
    profileById,
    draftByPlatformId,
    priorByPlatformId,
    ledgerInPeriod,
    ledgerActive,
    housingByEmployee,
    electionsByEmployee,
  };
}

/** Profile employee id -> platform id lookup. */
export function platformIdFor(ctx: CheckContext, profileEmployeeId: string): string | undefined {
  return ctx.profileById.get(profileEmployeeId)?.platformEmployeeId;
}

/** Earning sum by type. */
export function earning(e: DraftEmployee, type: string): number {
  return e.earnings.filter((l) => l.type === type).reduce((s, l) => s + l.amountCents, 0);
}

/** Hours recorded on earning lines of a type. */
export function earningHours(e: DraftEmployee, type: string): number {
  return e.earnings.filter((l) => l.type === type).reduce((s, l) => s + (l.hours ?? 0), 0);
}

export function sumTypes(e: DraftEmployee, types: Set<string>): number {
  return e.earnings.filter((l) => types.has(l.type)).reduce((s, l) => s + l.amountCents, 0);
}

export function recurringGross(e: DraftEmployee): number {
  return sumTypes(e, RECURRING_EARNING_TYPES);
}

export function baseSalary(e: DraftEmployee): number {
  return sumTypes(e, BASE_SALARY_TYPES);
}

/**
 * Fraction of the period that falls in [from, to], by the configured
 * proration method. `from` and `to` are clamped to the period. Returns 1
 * when the whole period is covered.
 */
export function periodFraction(period: Period, config: EngineConfig, from?: string, to?: string): number {
  const s = from && from > period.start ? from : period.start;
  const e = to && to < period.end ? to : period.end;
  if (e < s) return 0;
  const count = config.prorationMethod === "work_days" ? workDays : calendarDays;
  const whole = count(period.start, period.end);
  if (whole === 0) return 0;
  return count(s, e) / whole;
}

/**
 * Expected base salary for the period at an annual rate, prorated for a
 * first paid day (`from`) and a last paid day (`to`) inside the period.
 */
export function expectedSalaryForPeriod(
  annualCents: number,
  freq: PayFrequency,
  period: Period,
  config: EngineConfig,
  from?: string,
  to?: string,
): number {
  return Math.round(perPeriodSalary(annualCents, freq) * periodFraction(period, config, from, to));
}

/**
 * Expected base salary for a period in which the rate moved from `oldAnnual`
 * to `newAnnual` on `effectiveDate`.
 */
export function expectedSalaryWithRateChange(
  oldAnnual: number,
  newAnnual: number,
  effectiveDate: string,
  freq: PayFrequency,
  period: Period,
  config: EngineConfig,
  from?: string,
  to?: string,
): number {
  if (effectiveDate <= (from && from > period.start ? from : period.start)) return expectedSalaryForPeriod(newAnnual, freq, period, config, from, to);
  const before = expectedSalaryForPeriod(oldAnnual, freq, period, config, from, addDays(effectiveDate, -1));
  const after = expectedSalaryForPeriod(newAnnual, freq, period, config, effectiveDate, to);
  return before + after;
}

/** Expected per-period regular pay from the profile rate (no proration). */
export function expectedRegularCents(p: ProfileEmployee, payFrequency: PayFrequency, hours: number): number {
  if (p.payType === "hourly") return Math.round(p.rateCents * hours);
  return perPeriodSalary(p.rateCents, payFrequency);
}

/** Standard hours for a full period at a frequency, scaled from 80 per biweekly period. */
export function scaledHours(biweeklyHours: number, freq: PayFrequency): number {
  return (biweeklyHours * 26) / periodsPerYear(freq);
}

/** Stable sort key for a name-plus-code ordering. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
