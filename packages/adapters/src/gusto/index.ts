/**
 * Gusto accountant-partner adapter. Read-only. One firm credential across every
 * administered company. Requires GUSTO_ACCESS_TOKEN (partner OAuth) and
 * GUSTO_API_BASE. Every call is a GET; nothing here can change a payroll.
 */
import type { DraftRun } from "@payroll-qa/engine";
import type { PlatformAdapter } from "../index.js";
import {
  HOUSING_NAMES,
  mapGustoPayroll,
  sumHousing,
  type GustoCompanyBenefit,
  type GustoContext,
  type GustoEmployee,
  type GustoLocation,
  type GustoPaySchedule,
  type GustoPayroll,
  type GustoTaxRequirement,
} from "./map.js";

export interface GustoAdapterOptions {
  accessToken: string;
  apiBase?: string; // https://api.gusto.com or https://api.gusto-demo.com
  apiVersion?: string; // X-Gusto-API-Version
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the wall clock, which is fine outside the engine. */
  now?: () => Date;
  /** Delay between retries on 429; injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface PayrollListItem {
  payroll_uuid: string;
  processed: boolean;
  check_date?: string;
  pay_period: { start_date: string; end_date: string };
}

export class GustoAdapter implements PlatformAdapter {
  platform = "gusto" as const;
  private base: string;
  private token: string;
  private version: string;
  private fetchImpl: typeof fetch;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private catalog?: Promise<Map<string | number, { pretax?: boolean; posttax?: boolean; imputed?: boolean }>>;

  constructor(opts: GustoAdapterOptions) {
    this.base = (opts.apiBase ?? "https://api.gusto.com").replace(/\/$/, "");
    this.token = opts.accessToken;
    this.version = opts.apiVersion ?? "2024-04-01";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, "X-Gusto-API-Version": this.version, Accept: "application/json" },
    });
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      await this.sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`Gusto ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  /** Walk a paginated list (per=100) until a short page. */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 100; page++) {
      const batch = await this.get<T[]>(`${path}${sep}per=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async listCompanies() {
    const me = await this.get<{ roles?: { payroll_admin?: { companies?: { uuid: string; name: string }[] } } }>("/v1/me");
    const companies = me.roles?.payroll_admin?.companies ?? [];
    return companies.map((c) => ({ platformCompanyId: c.uuid, name: c.name })).sort((a, b) => a.platformCompanyId.localeCompare(b.platformCompanyId));
  }

  /** GET /v1/benefits: the catalog of benefit types with their tax treatment. Cached for the adapter's life. */
  private benefitCatalog() {
    this.catalog ??= this.get<{ benefit_type?: number | string; id?: number | string; pretax?: boolean; posttax?: boolean; imputed?: boolean }[]>("/v1/benefits")
      .then((rows) => new Map(rows.map((r) => [r.benefit_type ?? r.id ?? "", { pretax: r.pretax, posttax: r.posttax, imputed: r.imputed }])))
      .catch(() => new Map());
    return this.catalog;
  }

  private async companyBenefits(companyId: string): Promise<GustoCompanyBenefit[] | undefined> {
    try {
      const [rows, catalog] = await Promise.all([
        this.get<{ uuid: string; description?: string; benefit_type?: number | string }[]>(`/v1/companies/${companyId}/company_benefits`),
        this.benefitCatalog(),
      ]);
      return rows.map((r) => ({ ...r, ...(r.benefit_type !== undefined ? catalog.get(r.benefit_type) ?? {} : {}) }));
    } catch {
      return undefined; // C5 states the treatment as unverified
    }
  }

  private async context(companyId: string, payroll: GustoPayroll, wantYtdHousing: boolean): Promise<GustoContext> {
    const [employees, paySchedules, locations, blockers, companyBenefits, taxRequirements] = await Promise.all([
      this.getAll<GustoEmployee>(`/v1/companies/${companyId}/employees?include=jobs`),
      this.get<GustoPaySchedule[]>(`/v1/companies/${companyId}/pay_schedules`),
      this.get<GustoLocation[]>(`/v1/companies/${companyId}/locations`),
      this.get<{ blocker_type: string; message: string; employee_uuid?: string }[]>(`/v1/companies/${companyId}/payrolls/blockers`),
      this.companyBenefits(companyId),
      this.get<GustoTaxRequirement[]>(`/v1/companies/${companyId}/tax_requirements`).catch(() => undefined),
    ]);
    const hasHousing = payroll.employee_compensations.some((c) => (c.fixed_compensations ?? []).some((f) => HOUSING_NAMES.test(f.name)));
    const ytdHousingByEmployee = wantYtdHousing && hasHousing ? await this.ytdHousing(companyId, payroll) : undefined;
    return { companyId, payroll, employees, paySchedules, locations, blockers, companyBenefits, taxRequirements, ytdHousingByEmployee, pulledAt: this.now().toISOString() };
  }

  /** Housing paid on processed payrolls with a check date in the same calendar year and before this payroll's check date. */
  private async ytdHousing(companyId: string, payroll: GustoPayroll): Promise<Record<string, number>> {
    const year = payroll.check_date.slice(0, 4);
    const list = await this.get<PayrollListItem[]>(`/v1/companies/${companyId}/payrolls?processing_statuses=processed&start_date=${year}-01-01&end_date=${payroll.check_date}&per=100`);
    const prior = list.filter((p) => p.processed && p.payroll_uuid !== payroll.payroll_uuid && (p.check_date ?? p.pay_period.end_date) < payroll.check_date && (p.check_date ?? "").startsWith(year));
    const full = await Promise.all(prior.map((p) => this.payroll(companyId, p.payroll_uuid)));
    return sumHousing(full);
  }

  private payroll(companyId: string, payrollId: string): Promise<GustoPayroll> {
    return this.get<GustoPayroll>(`/v1/companies/${companyId}/payrolls/${payrollId}?include=benefits&include=deductions&include=taxes`);
  }

  private async nextUnprocessed(companyId: string, onOrAfter: string): Promise<PayrollListItem | undefined> {
    const list = await this.get<PayrollListItem[]>(`/v1/companies/${companyId}/payrolls?processing_statuses=unprocessed&start_date=${onOrAfter}&per=100`);
    return list.filter((p) => !p.processed).sort((a, b) => a.pay_period.end_date.localeCompare(b.pay_period.end_date) || a.payroll_uuid.localeCompare(b.payroll_uuid))[0];
  }

  async nextPeriod(companyId: string, onOrAfter: string) {
    const next = await this.nextUnprocessed(companyId, onOrAfter);
    if (!next) return null;
    const checkDate = next.check_date ?? (await this.payroll(companyId, next.payroll_uuid)).check_date;
    return { period: { start: next.pay_period.start_date, end: next.pay_period.end_date, payDate: checkDate }, platformPayrollId: next.payroll_uuid };
  }

  async pullDraft(companyId: string, onOrAfter: string): Promise<DraftRun | null> {
    const next = await this.nextUnprocessed(companyId, onOrAfter);
    if (!next) return null;
    const payroll = await this.payroll(companyId, next.payroll_uuid);
    return mapGustoPayroll(await this.context(companyId, payroll, true));
  }

  async pullPrior(companyId: string, before: string): Promise<DraftRun | null> {
    const from = new Date(Date.parse(before) - 120 * 864e5).toISOString().slice(0, 10);
    const list = await this.get<PayrollListItem[]>(`/v1/companies/${companyId}/payrolls?processing_statuses=processed&start_date=${from}&end_date=${before}&per=100`);
    const last = list.filter((p) => p.processed && p.pay_period.end_date < before).sort((a, b) => b.pay_period.end_date.localeCompare(a.pay_period.end_date) || b.payroll_uuid.localeCompare(a.payroll_uuid))[0];
    if (!last) return null;
    const payroll = await this.payroll(companyId, last.payroll_uuid);
    return mapGustoPayroll(await this.context(companyId, payroll, false));
  }

  /** The processed register for a specific payroll, for the post-submit comparison. */
  async pullProcessed(companyId: string, payrollId: string): Promise<DraftRun | null> {
    const payroll = await this.payroll(companyId, payrollId);
    if (!payroll.processed) return null;
    return mapGustoPayroll(await this.context(companyId, payroll, false));
  }
}
