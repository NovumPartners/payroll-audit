import {
  DEFAULT_CONFIG,
  type BenefitElection,
  type CheckContext,
  type ChangeRequest,
  type DraftEmployee,
  type HousingAllowance,
  type ProfileEmployee,
  type RunInput,
} from "./types.js";

export function inPeriod(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

export function activeOn(date: string, from: string, to?: string): boolean {
  return date >= from && (to === undefined || date <= to);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function buildContext(input: RunInput): CheckContext {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const profileByPlatformId = new Map<string, ProfileEmployee>();
  for (const e of input.profile.employees) profileByPlatformId.set(e.platformEmployeeId, e);

  const draftByPlatformId = new Map<string, DraftEmployee>();
  for (const e of input.draft.employees) draftByPlatformId.set(e.platformEmployeeId, e);

  const priorByPlatformId = new Map<string, DraftEmployee>();
  for (const e of input.prior?.employees ?? []) priorByPlatformId.set(e.platformEmployeeId, e);

  const { start, end } = input.draft.period;
  const ledgerInPeriod: ChangeRequest[] = input.ledger.filter(
    (c) => c.clientId === input.profile.clientId && inPeriod(c.effectiveDate, start, end) && c.status !== "rejected",
  );

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

  return {
    ...input,
    config,
    profileByPlatformId,
    draftByPlatformId,
    priorByPlatformId,
    ledgerInPeriod,
    housingByEmployee,
    electionsByEmployee,
  };
}

/** Profile employee id -> platform id lookup. */
export function platformIdFor(ctx: CheckContext, profileEmployeeId: string): string | undefined {
  return ctx.profile.employees.find((e) => e.id === profileEmployeeId)?.platformEmployeeId;
}

/** Earning sum by type. */
export function earning(e: DraftEmployee, type: string): number {
  return e.earnings.filter((l) => l.type === type).reduce((s, l) => s + l.amountCents, 0);
}

/** Expected per-period regular pay from the profile rate. */
export function expectedRegularCents(p: ProfileEmployee, payFrequency: string, hours: number): number {
  if (p.payType === "hourly") return Math.round(p.rateCents * hours);
  const periods = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }[payFrequency] ?? 24;
  return Math.round(p.rateCents / periods);
}
