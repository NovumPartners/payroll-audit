/**
 * Gusto -> normalized DraftRun.
 * Shapes follow the Gusto API (GET /v1/companies/{id}/payrolls/{payroll_id}
 * with include=benefits&include=deductions&include=taxes). Field names are
 * kept narrow so a schema drift fails loudly in `mapGustoPayroll` rather than
 * silently in a check. Nothing here is inferred from a name except the
 * earning-type classification, which maps Gusto's free-text earning names
 * onto the engine's type vocabulary and is covered by tests.
 */
import type { DeductionLine, DraftEmployee, DraftRun, EarningLine, PayFrequency, PlatformBlocker } from "@payroll-qa/engine";
import { periodsPerYear } from "@payroll-qa/engine";

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
  deductions?: { name: string; amount: string | number }[];
  taxes?: { name: string; employer: boolean; amount: string | number }[];
}

export interface GustoEmployee {
  uuid: string;
  first_name: string;
  last_name: string;
  work_email?: string;
  jobs?: { uuid: string; primary: boolean; location_uuid?: string; current_compensation_uuid?: string; hire_date?: string; compensations?: GustoJobCompensation[] }[];
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

/** A company benefit joined to its catalog entry (GET /v1/benefits gives pretax/posttax/imputed per benefit_type). */
export interface GustoCompanyBenefit {
  uuid: string;
  description?: string;
  benefit_type?: number | string;
  pretax?: boolean;
  posttax?: boolean;
  imputed?: boolean;
}

export interface GustoTaxRequirement {
  state: string;
  setup_complete?: boolean; // API versions before 2026-06-15
  ready_to_run_payroll?: boolean; // 2026-06-15 and later
}

export interface GustoContext {
  companyId: string;
  payroll: GustoPayroll;
  employees: GustoEmployee[];
  paySchedules: GustoPaySchedule[];
  locations: GustoLocation[];
  blockers: { blocker_type: string; message: string; employee_uuid?: string }[];
  /** Earning types configured for the company; used for C4 when the platform reports taxability. */
  earningTypes?: { name: string; uuid: string; taxable?: boolean }[];
  /** Company benefits joined to the catalog; used for pre-tax treatment (C5). */
  companyBenefits?: GustoCompanyBenefit[];
  /** States and their setup status; used for C8. undefined when the call was not made. */
  taxRequirements?: GustoTaxRequirement[];
  /** Housing allowance paid in processed payrolls this calendar year, by employee uuid, before this payroll. */
  ytdHousingByEmployee?: Record<string, number>;
  pulledAt: string;
}

export const cents = (v: string | number | undefined): number => Math.round(Number(v ?? 0) * 100);
const num = (v: string | number | undefined): number => Number(v ?? 0);

export const HOUSING_NAMES = /housing|parsonage|minister.*allowance|clergy.*allowance/i;

export function mapGustoFrequency(f: GustoPaySchedule["frequency"] | undefined): PayFrequency {
  switch (f) {
    case "Every week":
      return "weekly";
    case "Every other week":
      return "biweekly";
    case "Monthly":
      return "monthly";
    case "Twice per month":
      return "semimonthly";
    default:
      throw new Error(`Gusto pay schedule frequency not recognised: ${String(f)}`);
  }
}

export function classifyEarning(name: string): string {
  const n = name.toLowerCase();
  if (HOUSING_NAMES.test(name)) return "housing_allowance";
  if (n.includes("double overtime") || n.includes("overtime")) return "overtime";
  if (n.includes("bonus")) return "bonus";
  if (n.includes("commission")) return "commission";
  if (n.includes("retro")) return "retro";
  if (n.includes("holiday")) return "holiday";
  if (n.includes("sick")) return "sick";
  if (n.includes("regular") || n.includes("salary")) return "regular";
  if (n.includes("reimburse")) return "reimbursement";
  return n.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Annual salary cents (or hourly cents) from a Gusto compensation and the schedule's frequency. */
export function annualizeRate(comp: GustoJobCompensation | undefined, freq: PayFrequency): { payType: "salary" | "hourly"; rateCents: number } {
  if (!comp) return { payType: "salary", rateCents: 0 };
  const r = cents(comp.rate);
  switch (comp.payment_unit) {
    case "Hour":
      return { payType: "hourly", rateCents: r };
    case "Year":
      return { payType: "salary", rateCents: r };
    case "Month":
      return { payType: "salary", rateCents: r * 12 };
    case "Week":
      return { payType: "salary", rateCents: r * 52 };
    case "Paycheck":
      return { payType: "salary", rateCents: r * periodsPerYear(freq) };
  }
}

export function mapGustoPayroll(ctx: GustoContext): DraftRun {
  const sched = ctx.paySchedules.find((s) => s.uuid === ctx.payroll.pay_period.pay_schedule_uuid) ?? (ctx.paySchedules.length === 1 ? ctx.paySchedules[0] : undefined);
  if (!sched) throw new Error(`Gusto payroll ${ctx.payroll.payroll_uuid}: pay schedule ${ctx.payroll.pay_period.pay_schedule_uuid ?? "(none)"} not found among ${ctx.paySchedules.length} schedules`);
  const payFrequency = mapGustoFrequency(sched.frequency);
  const employeesById = new Map(ctx.employees.map((e) => [e.uuid, e]));
  const locationState = new Map(ctx.locations.map((l) => [l.uuid, l.state]));
  const benefitByUuid = new Map((ctx.companyBenefits ?? []).map((b) => [b.uuid, b]));
  const benefitByName = new Map((ctx.companyBenefits ?? []).filter((b) => b.description).map((b) => [b.description!, b]));

  const housingType = ctx.earningTypes?.find((t) => HOUSING_NAMES.test(t.name));
  const platformHousingEarningExcluded = housingType && housingType.taxable !== undefined ? housingType.taxable === false : undefined;

  const employees: DraftEmployee[] = ctx.payroll.employee_compensations.map((c) => {
    const e = employeesById.get(c.employee_uuid);
    const name = e ? `${e.first_name} ${e.last_name}`.trim() : c.employee_uuid;
    const job = e?.jobs?.find((j) => j.primary) ?? e?.jobs?.[0];
    const comp = job?.compensations?.find((x) => x.uuid === job.current_compensation_uuid) ?? job?.compensations?.at(-1);
    const { payType, rateCents } = annualizeRate(comp, payFrequency);

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

    const deductions: DeductionLine[] = (c.benefits ?? []).map((b) => {
      const cat = (b.company_benefit_uuid && benefitByUuid.get(b.company_benefit_uuid)) || benefitByName.get(b.name);
      const preTax = cat && cat.pretax !== undefined ? cat.pretax && !cat.imputed : undefined;
      return {
        planId: b.company_benefit_uuid ?? cat?.uuid,
        name: b.name,
        employeeCents: cents(b.employee_deduction),
        employerCents: cents(b.company_contribution),
        preTax,
      };
    });
    for (const d of c.deductions ?? []) {
      if (cents(d.amount) === 0) continue;
      deductions.push({ name: d.name, employeeCents: cents(d.amount), employerCents: 0, preTax: false }); // Gusto deductions (garnishments, post-tax) are post-tax by definition
    }

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
      ytdHousingCents: ctx.ytdHousingByEmployee ? (ctx.ytdHousingByEmployee[c.employee_uuid] ?? 0) : undefined,
    };
  });

  const blockers: PlatformBlocker[] = ctx.blockers.map((b) => ({ code: b.blocker_type, message: b.message, employeeId: b.employee_uuid }));

  const stateTaxSetup = ctx.taxRequirements
    ? [...new Set(ctx.taxRequirements.filter((t) => t.setup_complete === true || t.ready_to_run_payroll === true).map((t) => t.state))].sort()
    : undefined;

  return {
    clientId: ctx.companyId,
    platform: "gusto",
    platformPayrollId: ctx.payroll.payroll_uuid,
    period: { start: ctx.payroll.pay_period.start_date, end: ctx.payroll.pay_period.end_date, payDate: ctx.payroll.check_date },
    payFrequency,
    employees,
    blockers,
    platformHousingEarningExcluded,
    stateTaxSetup,
    pulledAt: ctx.pulledAt,
  };
}

/** Sum housing lines by employee across processed payrolls (for C2's annual cap). */
export function sumHousing(payrolls: GustoPayroll[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of payrolls) {
    for (const c of p.employee_compensations) {
      for (const f of c.fixed_compensations ?? []) {
        if (classifyEarning(f.name) === "housing_allowance") out[c.employee_uuid] = (out[c.employee_uuid] ?? 0) + cents(f.amount);
      }
    }
  }
  return out;
}
