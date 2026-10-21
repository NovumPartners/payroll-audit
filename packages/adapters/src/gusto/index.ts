/**
 * Gusto accountant-partner adapter. Read-only. One firm credential across every
 * administered company. Requires GUSTO_ACCESS_TOKEN (partner OAuth) and GUSTO_API_BASE.
 */
import type { DraftRun } from "@payroll-qa/engine";
import type { PlatformAdapter } from "../index.js";
import { mapGustoPayroll, type GustoContext, type GustoEmployee, type GustoLocation, type GustoPaySchedule, type GustoPayroll } from "./map.js";

export interface GustoAdapterOptions {
  accessToken: string;
  apiBase?: string; // https://api.gusto.com or https://api.gusto-demo.com
  apiVersion?: string; // X-Gusto-API-Version
  fetchImpl?: typeof fetch;
}

export class GustoAdapter implements PlatformAdapter {
  platform = "gusto" as const;
  private base: string;
  private token: string;
  private version: string;
  private fetchImpl: typeof fetch;

  constructor(opts: GustoAdapterOptions) {
    this.base = (opts.apiBase ?? "https://api.gusto.com").replace(/\/$/, "");
    this.token = opts.accessToken;
    this.version = opts.apiVersion ?? "2024-04-01";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, "X-Gusto-API-Version": this.version, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Gusto ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  async listCompanies() {
    const me = await this.get<{ roles?: { payroll_admin?: { companies?: { uuid: string; name: string }[] } } }>("/v1/me");
    const companies = me.roles?.payroll_admin?.companies ?? [];
    return companies.map((c) => ({ platformCompanyId: c.uuid, name: c.name }));
  }

  private async context(companyId: string, payroll: GustoPayroll): Promise<GustoContext> {
    const [employees, paySchedules, locations, blockers] = await Promise.all([
      this.get<GustoEmployee[]>(`/v1/companies/${companyId}/employees?include=jobs&per=100`),
      this.get<GustoPaySchedule[]>(`/v1/companies/${companyId}/pay_schedules`),
      this.get<GustoLocation[]>(`/v1/companies/${companyId}/locations`),
      this.get<{ blocker_type: string; message: string; employee_uuid?: string }[]>(`/v1/companies/${companyId}/payrolls/${payroll.payroll_uuid}/blockers`).catch(() => []),
    ]);
    return { companyId, payroll, employees, paySchedules, locations, blockers, pulledAt: new Date().toISOString() };
  }

  async pullDraft(companyId: string, onOrAfter: string): Promise<DraftRun | null> {
    const list = await this.get<{ payroll_uuid: string; processed: boolean; pay_period: { start_date: string; end_date: string } }[]>(
      `/v1/companies/${companyId}/payrolls?processing_statuses=unprocessed&start_date=${onOrAfter}`,
    );
    const next = list.filter((p) => !p.processed).sort((a, b) => a.pay_period.end_date.localeCompare(b.pay_period.end_date))[0];
    if (!next) return null;
    const payroll = await this.get<GustoPayroll>(`/v1/companies/${companyId}/payrolls/${next.payroll_uuid}?include=employee_compensations,taxes,benefits`);
    return mapGustoPayroll(await this.context(companyId, payroll));
  }

  async pullPrior(companyId: string, before: string): Promise<DraftRun | null> {
    const list = await this.get<{ payroll_uuid: string; processed: boolean; pay_period: { start_date: string; end_date: string } }[]>(
      `/v1/companies/${companyId}/payrolls?processing_statuses=processed&end_date=${before}`,
    );
    const last = list.filter((p) => p.processed && p.pay_period.end_date < before).sort((a, b) => b.pay_period.end_date.localeCompare(a.pay_period.end_date))[0];
    if (!last) return null;
    const payroll = await this.get<GustoPayroll>(`/v1/companies/${companyId}/payrolls/${last.payroll_uuid}?include=employee_compensations,taxes,benefits`);
    return mapGustoPayroll(await this.context(companyId, payroll));
  }
}
