/**
 * Rippling phase 1: scheduled CSV exports dropped in a watched Box folder per client.
 * Expected files per cycle: register.csv (one row per employee per earning/deduction line)
 * and roster.csv (employee, pay type, rate, work state, PTO balance).
 * Column names are configurable because Rippling report exports are user-defined.
 */
import type { DraftEmployee, DraftRun, PayFrequency } from "@payroll-qa/engine";
import type { PlatformAdapter } from "../index.js";

export interface RipplingColumns {
  employeeId: string;
  employeeName: string;
  lineType: string; // "earning" | "deduction" | "tax" | "net"
  lineName: string;
  amount: string;
  hours?: string;
  employerAmount?: string;
  /** Column holding "Pre-tax" / "Post-tax" for deduction lines. Absent, tax treatment is left unknown and C5 says so. */
  taxTreatment?: string;
}

export interface RipplingRosterColumns {
  employeeId: string;
  payType: string; // values "Salary" | "Hourly"
  rate: string;
  workState: string;
  ptoBalanceHours?: string;
  ytdHousing?: string;
}

export const DEFAULT_REGISTER_COLUMNS: RipplingColumns = {
  employeeId: "Employee ID",
  employeeName: "Employee Name",
  lineType: "Line Type",
  lineName: "Line Name",
  amount: "Amount",
  hours: "Hours",
  employerAmount: "Employer Amount",
  taxTreatment: "Tax Treatment",
};

export const DEFAULT_ROSTER_COLUMNS: RipplingRosterColumns = {
  employeeId: "Employee ID",
  payType: "Pay Type",
  rate: "Rate",
  workState: "Work State",
  ptoBalanceHours: "PTO Balance (hours)",
  ytdHousing: "YTD Housing Allowance",
};

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas and quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((r) => r.some((c) => c.trim() !== "")).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const cents = (v: string | undefined): number => {
  const s = (v ?? "").replace(/[$,\s]/g, "");
  if (s === "") return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`Rippling export: amount is not a number: ${v}`);
  return Math.round(n * 100) * (neg ? -1 : 1);
};
const HOUSING = /housing|parsonage|clergy/i;

function classify(name: string): string {
  const n = name.toLowerCase();
  if (HOUSING.test(name)) return "housing_allowance";
  if (n.includes("overtime")) return "overtime";
  if (n.includes("bonus")) return "bonus";
  if (n.includes("retro")) return "retro";
  if (n.includes("pto payout") || n.includes("vacation payout")) return "pto_payout";
  if (n.includes("pto") || n.includes("vacation")) return "pto";
  if (n.includes("regular") || n.includes("salary")) return "regular";
  return n.replace(/[^a-z0-9]+/g, "_");
}

export function parseRipplingRegister(
  registerCsv: string,
  rosterCsv: string,
  meta: { clientId: string; platformPayrollId: string; period: DraftRun["period"]; payFrequency: PayFrequency; pulledAt: string },
  cols: RipplingColumns = DEFAULT_REGISTER_COLUMNS,
  rosterCols: RipplingRosterColumns = DEFAULT_ROSTER_COLUMNS,
): DraftRun {
  const roster = new Map(parseCsv(rosterCsv).map((r) => [r[rosterCols.employeeId] ?? "", r]));
  const byEmp = new Map<string, DraftEmployee>();
  for (const r of parseCsv(registerCsv)) {
    const id = r[cols.employeeId] ?? "";
    if (!id) continue;
    let e = byEmp.get(id);
    if (!e) {
      const ro = roster.get(id);
      const payType = (ro?.[rosterCols.payType] ?? "").toLowerCase().startsWith("hour") ? "hourly" : "salary";
      e = {
        platformEmployeeId: id,
        name: r[cols.employeeName] ?? id,
        payType,
        rateCents: cents(ro?.[rosterCols.rate]),
        hours: 0,
        earnings: [],
        deductions: [],
        taxes: { socialSecurityEmployeeCents: 0, medicareEmployeeCents: 0, socialSecurityEmployerCents: 0, medicareEmployerCents: 0, federalWithholdingCents: 0 },
        grossCents: 0,
        netCents: 0,
        workState: ro?.[rosterCols.workState] ?? "",
        timeOffBalanceHours: rosterCols.ptoBalanceHours && ro?.[rosterCols.ptoBalanceHours] ? Number(ro[rosterCols.ptoBalanceHours]) : undefined,
        ytdHousingCents: rosterCols.ytdHousing && ro?.[rosterCols.ytdHousing] ? cents(ro[rosterCols.ytdHousing]) : undefined,
      };
      byEmp.set(id, e);
    }
    const kind = (r[cols.lineType] ?? "").toLowerCase();
    const name = r[cols.lineName] ?? "";
    const amt = cents(r[cols.amount]);
    if (kind.startsWith("earn")) {
      const hrs = cols.hours && r[cols.hours] ? Number(r[cols.hours]) : undefined;
      if (hrs) e.hours += hrs;
      e.earnings.push({ type: classify(name), amountCents: amt, hours: hrs });
      e.grossCents += amt;
    } else if (kind.startsWith("ded") || kind.startsWith("benefit")) {
      const treatment = cols.taxTreatment ? (r[cols.taxTreatment] ?? "").toLowerCase() : "";
      const preTax = treatment.startsWith("pre") ? true : treatment.startsWith("post") ? false : undefined;
      e.deductions.push({ name, planId: name, employeeCents: amt, employerCents: cents(cols.employerAmount ? r[cols.employerAmount] : "0"), preTax });
    } else if (kind.startsWith("tax")) {
      const employer = /employer/i.test(name);
      if (/social security|oasdi/i.test(name)) employer ? (e.taxes.socialSecurityEmployerCents += amt) : (e.taxes.socialSecurityEmployeeCents += amt);
      else if (/medicare/i.test(name)) employer ? (e.taxes.medicareEmployerCents += amt) : (e.taxes.medicareEmployeeCents += amt);
      else if (/federal income|fit/i.test(name) && !employer) e.taxes.federalWithholdingCents += amt;
    } else if (kind.startsWith("net")) {
      e.netCents = amt;
    }
  }
  for (const e of byEmp.values()) {
    if (e.netCents === 0 && e.grossCents !== 0) {
      const empTax = e.taxes.socialSecurityEmployeeCents + e.taxes.medicareEmployeeCents + e.taxes.federalWithholdingCents;
      e.netCents = e.grossCents - empTax - e.deductions.reduce((s, d) => s + d.employeeCents, 0);
    }
  }
  return {
    clientId: meta.clientId,
    platform: "rippling",
    platformPayrollId: meta.platformPayrollId,
    period: meta.period,
    payFrequency: meta.payFrequency,
    employees: [...byEmp.values()].sort((a, b) => a.platformEmployeeId.localeCompare(b.platformEmployeeId)),
    blockers: [],
    // an export carries no tax-setup data; C8 falls back to the signed profile's registered states
    pulledAt: meta.pulledAt,
  };
}

/** Watches a Box folder for `register.csv` and `roster.csv` under <folder>/payroll-exports/<period_end>/. */
export class RipplingCsvAdapter implements PlatformAdapter {
  platform = "rippling" as const;
  constructor(
    private readFile: (clientFolderId: string, relativePath: string) => Promise<string | null>,
    private clients: { platformCompanyId: string; name: string; boxFolderId: string; payFrequency: PayFrequency; nextPeriod: DraftRun["period"]; priorPeriod?: DraftRun["period"] }[],
    private now: () => Date = () => new Date(),
  ) {}

  async listCompanies() {
    return this.clients.map((c) => ({ platformCompanyId: c.platformCompanyId, name: c.name }));
  }

  private async load(c: (typeof this.clients)[number], period: DraftRun["period"]): Promise<DraftRun | null> {
    const dir = `payroll-exports/${period.end}`;
    const [register, roster] = await Promise.all([this.readFile(c.boxFolderId, `${dir}/register.csv`), this.readFile(c.boxFolderId, `${dir}/roster.csv`)]);
    if (!register || !roster) return null;
    return parseRipplingRegister(register, roster, {
      clientId: c.platformCompanyId,
      platformPayrollId: `rippling_${period.end}`,
      period,
      payFrequency: c.payFrequency,
      pulledAt: this.now().toISOString(),
    });
  }

  async pullDraft(platformCompanyId: string) {
    const c = this.clients.find((x) => x.platformCompanyId === platformCompanyId);
    return c ? this.load(c, c.nextPeriod) : null;
  }

  async pullPrior(platformCompanyId: string) {
    const c = this.clients.find((x) => x.platformCompanyId === platformCompanyId);
    return c?.priorPeriod ? this.load(c, c.priorPeriod) : null;
  }
}
