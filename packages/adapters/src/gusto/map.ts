/**
 * Gusto -> normalized DraftRun.
 * Shapes follow the Gusto v2024-04-01 API (GET /v1/companies/{id}/payrolls/{payroll_id}
 * with include=employee_compensations&include=taxes&include=benefits). Field names are kept
 * narrow so a schema drift fails loudly in `mapGustoPayroll` rather than silently in a check.
 */
import type { DraftEmployee, DraftRun, EarningLine, PayFrequency, PlatformBlocker } from "@payroll-qa/engine";

export interface GustoPayroll {
  payroll_uuid: string;
  processed: boolean;
  pay_period: { start_date: string; end_date: string; pay_schedule_uuid?: string };
  check_date: string;
  employee_compensations: GustoCompensation[];
}

export interface GustoCompensation {
  employee_uuid: string;
  gross_pay?: string | number;
  net_pay?: string | number;
  fixed_compensations?: { name: string; amount: string | number; job_uuid?: string }[];
  hourly_compensations?: { name: string; hours: string | number; amount?: string | number; compensation_multiplier?: number; job_uuid?: string }[];
  paid_time_off?: { name: string; hours: string | number; final_payout_unused_hours_input?: string | number }[];
  benefits?: { name: string; employee_deduction: string | number; company_contribution: string | number; imputed?: boolean; company_benefit_uuid?: string }[];
  taxes?: { name: string; employer: boolean; amount: string | number }[];
}

export interface GustoEmployee {
  uuid: string;
  first_name: string;
  last_name: string;
  work_email?: string;
  jobs?: { uuid: string; primary: boolean; location_uuid?: string; current_compensation_uuid?: string; compensations?: GustoJobCompensation[] }[];
  terminated?: boolean;
}

export interface GustoJobCompensation {
  uuid: string;
  rate: string | number;
  payment_unit: "Hour" | "Week" | "Month" | "Year" | "Paycheck";
  flsa_status?: string;
  effective_date?: string;
}

export interface GustoPaySchedule {
  uuid: string;
  frequency: "Every week" | "Every other week" | "Twice per month" | "Monthly";
}

export interface GustoLocation {
  uuid: string;
  state: string;
}

export interface GustoContext {
  companyId: string;
  payroll: GustoPayroll;
  employees: GustoEmployee[];
  paySchedules: GustoPaySchedule[];
  locations: GustoLocation[];
  blockers: { blocker_type: string; message: string; employee_uuid?: string }[];
  /** Earning types configured for the company; used for C4. */
  earningTypes?: { name: string; uuid: string; taxable?: boolean }[];
  pulledAt: string;
}

const cents = (v: string | number | undefined): number => Math.round(Number(v ?? 0) * 100);
const num = (v: string | number | undefined): number => Number(v ?? 0);

const HOUSING_NAMES = /housing|parsonage|minister.*allowance/i;

export function mapGustoFrequency(f: GustoPaySchedule["frequency"] | undefined): PayFrequency {
  switch (f) {
    case "Every week":
      return "weekly";
    case "Every other week":
      return "biweekly";
    case "Monthly":
      return "monthly";
    default:
      return "semimonthly";
  }
}

function classifyEarning(name: string): string {
  const n = name.toLowerCase();
  if (HOUSING_NAMES.test(name)) return "housing_allowance";
  if (n.includes("overtime")) return "overtime";
  if (n.includes("bonus")) return "bonus";
  if (n.includes("commission")) return "commission";
  if (n.includes("retro")) return "retro";
  if (n.includes("regular") || n.includes("salary")) return "regular";
  if (n.includes("reimburse")) return "reimbursement";
  return n.replace(/[^a-z0-9]+/g, "_");
}

export function mapGustoPayroll(ctx: GustoContext): DraftRun {
  const sched = ctx.paySchedules.find((s) => s.uuid === ctx.payroll.pay_period.pay_schedule_uuid) ?? ctx.paySchedules[0];
  const employeesById = new Map(ctx.employees.map((e) => [e.uuid, e]));
  const locationState = new Map(ctx.locations.map((l) => [l.uuid, l.state]));

  const housingType = ctx.earningTypes?.find((t) => HOUSING_NAMES.test(t.name));
  const platformHousingEarningExcluded = housingType ? housingType.taxable === false : undefined;

  const employees: DraftEmployee[] = ctx.payroll.employee_compensations.map((c) => {
    const e = employeesById.get(c.employee_uuid);
    const name = e ? `${e.first_name} ${e.last_name}`.trim() : c.employee_uuid;
    const job = e?.jobs?.find((j) => j.primary) ?? e?.jobs?.[0];
    const comp = job?.compensations?.find((x) => x.uuid === job.current_compensation_uuid) ?? job?.compensations?.at(-1);
    const payType = comp?.payment_unit === "Hour" ? "hourly" : "salary";
    const rateCents = comp
      ? comp.payment_unit === "Year" || comp.payment_unit === "Hour"
        ? cents(comp.rate)
        : comp.payment_unit === "Month"
          ? cents(comp.rate) * 12
          : comp.payment_unit === "Week"
            ? cents(comp.rate) * 52
            : cents(comp.rate)
      : 0;

    const earnings: EarningLine[] = [];
    for (const f of c.fixed_compensations ?? []) {
      if (cents(f.amount) === 0) continue;
      const type = classifyEarning(f.name);
      earnings.push({ type, amountCents: cents(f.amount), excludedFromTaxableWages: type === "housing_allowance" ? platformHousingEarningExcluded : undefined });
    }
    let hours = 0;
    for (const h of c.hourly_compensations ?? []) {
      const hrs = num(h.hours);
      if (hrs === 0) continue;
      hours += hrs;
      const mult = h.compensation_multiplier ?? 1;
      const amount = h.amount !== undefined ? cents(h.amount) : Math.round(rateCents * hrs * mult);
      earnings.push({ type: mult > 1 ? "overtime" : classifyEarning(h.name), amountCents: amount, hours: hrs });
    }
    for (const p of c.paid_time_off ?? []) {
      const hrs = num(p.hours);
      if (hrs > 0) earnings.push({ type: "pto", amountCents: payType === "hourly" ? Math.round(rateCents * hrs) : 0, hours: hrs });
      const payout = num(p.final_payout_unused_hours_input);
      if (payout > 0) earnings.push({ type: "pto_payout", amountCents: Math.round(rateCents * payout), hours: payout });
    }

    const deductions = (c.benefits ?? []).map((b) => ({
      planId: b.company_benefit_uuid,
      name: b.name,
      employeeCents: cents(b.employee_deduction),
      employerCents: cents(b.company_contribution),
      preTax: !b.imputed,
    }));

    const tax = (needle: RegExp, employer: boolean) =>
      (c.taxes ?? []).filter((t) => t.employer === employer && needle.test(t.name)).reduce((s, t) => s + cents(t.amount), 0);

    const gross = c.gross_pay !== undefined ? cents(c.gross_pay) : earnings.reduce((s, l) => s + l.amountCents, 0);

    return {
      platformEmployeeId: c.employee_uuid,
      name,
      payType,
      rateCents,
      hours,
      earnings,
      deductions,
      taxes: {
        socialSecurityEmployeeCents: tax(/social security/i, false),
        medicareEmployeeCents: tax(/medicare/i, false),
        socialSecurityEmployerCents: tax(/social security/i, true),
        medicareEmployerCents: tax(/medicare/i, true),
        federalWithholdingCents: tax(/federal income/i, false),
      },
      grossCents: gross,
      netCents: cents(c.net_pay),
      workState: (job?.location_uuid && locationState.get(job.location_uuid)) || "",
    };
  });

  const blockers: PlatformBlocker[] = ctx.blockers.map((b) => ({ code: b.blocker_type, message: b.message, employeeId: b.employee_uuid }));

  return {
    clientId: ctx.companyId,
    platform: "gusto",
    platformPayrollId: ctx.payroll.payroll_uuid,
    period: { start: ctx.payroll.pay_period.start_date, end: ctx.payroll.pay_period.end_date, payDate: ctx.payroll.check_date },
    payFrequency: mapGustoFrequency(sched?.frequency),
    employees,
    blockers,
    platformHousingEarningExcluded,
    stateTaxSetup: [...new Set(ctx.locations.map((l) => l.state))],
    pulledAt: ctx.pulledAt,
  };
}
