/**
 * JotForm webhook -> ChangeRequest.
 * JotForm posts multipart form data with `rawRequest` (JSON string of answers keyed by
 * field unique names, e.g. "q3_employeeName") plus `formID`, `submissionID`, `ip`.
 * Each Novum form is registered here with a field map, so a renamed field fails
 * mapping loudly instead of producing a half-filled request.
 */
import type { ChangePayload, ChangeRequest, ChangeType, PayFrequency, PayType } from "@payroll-qa/engine";
import type { WebhookMapper } from "../index.js";

export interface JotFormFieldMap {
  formId: string;
  type: ChangeType;
  clientKey: string; // field holding the client id or name
  employeeKey?: string; // field holding the platform employee id or name
  effectiveDateKey: string;
  submittedByKey: string;
  fields: Record<string, string>; // payload field -> JotForm unique field name
}

export interface JotFormRawSubmission {
  formID: string;
  submissionID: string;
  rawRequest: string | Record<string, unknown>;
  created_at?: string;
}

const cents = (v: unknown): number => Math.round(Number(String(v ?? "0").replace(/[$,]/g, "")) * 100);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v)).trim();
const bool = (v: unknown): boolean => /^(yes|true|1|y)$/i.test(str(v));

/** JotForm date widgets arrive as {month, day, year} or "MM/DD/YYYY" or "YYYY-MM-DD". */
export function normalizeDate(v: unknown): string {
  if (v && typeof v === "object" && "year" in (v as Record<string, unknown>)) {
    const o = v as Record<string, string>;
    return `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`;
  }
  const s = str(v);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  throw new Error(`Unrecognized date: ${s}`);
}

export class JotFormMapper implements WebhookMapper {
  private byForm: Map<string, JotFormFieldMap>;
  constructor(
    maps: JotFormFieldMap[],
    private resolve: { clientId: (key: string) => string; employeeId: (clientId: string, key: string) => string | undefined },
  ) {
    this.byForm = new Map(maps.map((m) => [m.formId, m]));
  }

  toChangeRequest(raw: unknown): ChangeRequest {
    const sub = raw as JotFormRawSubmission;
    const map = this.byForm.get(String(sub.formID));
    if (!map) throw new Error(`No field map for JotForm form ${sub.formID}`);
    const a: Record<string, unknown> = typeof sub.rawRequest === "string" ? JSON.parse(sub.rawRequest) : sub.rawRequest;
    const f = (k: string) => a[map.fields[k] ?? ""];
    const clientId = this.resolve.clientId(str(a[map.clientKey]));
    const employeeId = map.employeeKey ? this.resolve.employeeId(clientId, str(a[map.employeeKey])) : undefined;
    if (map.employeeKey && !employeeId) throw new Error(`Unknown employee "${str(a[map.employeeKey])}" for client ${clientId}`);

    let payload: ChangePayload;
    switch (map.type) {
      case "new_hire":
        payload = { kind: "new_hire", payType: (str(f("payType")).toLowerCase().startsWith("hour") ? "hourly" : "salary") as PayType, rateCents: cents(f("rate")), hireDate: normalizeDate(f("hireDate")) };
        break;
      case "termination":
        payload = { kind: "termination", terminationDate: normalizeDate(f("terminationDate")), payoutAccruedTimeOff: bool(f("payoutAccruedTimeOff")) };
        break;
      case "rate_change":
        payload = { kind: "rate_change", newRateCents: cents(f("newRate")) };
        break;
      case "housing_change":
        payload = { kind: "housing_change", annualAmountCents: cents(f("annualAmount")), perPeriodAmountCents: cents(f("perPeriodAmount")), resolutionDate: normalizeDate(f("resolutionDate")) };
        break;
      case "benefit_change":
        payload = { kind: "benefit_change", planId: str(f("planId")), employeeDeductionCents: cents(f("employeeDeduction")), employerContributionCents: cents(f("employerContribution")) };
        break;
      case "time_off_change":
        payload = { kind: "time_off_change", policyName: str(f("policyName")), accrualRateHours: Number(f("accrualRateHours") ?? 0), capHours: f("capHours") ? Number(f("capHours")) : undefined };
        break;
      case "one_time_pay":
        payload = { kind: "one_time_pay", earningType: str(f("earningType")).toLowerCase().replace(/[^a-z0-9]+/g, "_") || "bonus", amountCents: cents(f("amount")), description: str(f("description")) || undefined };
        break;
      case "deduction_change":
        payload = { kind: "deduction_change", deductionName: str(f("deductionName")), amountCents: cents(f("amount")) };
        break;
      case "schedule_change":
        payload = { kind: "schedule_change", payFrequency: str(f("payFrequency")).toLowerCase() as PayFrequency };
        break;
    }

    return {
      id: `jf_${sub.submissionID}`,
      clientId,
      employeeId,
      type: map.type,
      effectiveDate: normalizeDate(a[map.effectiveDateKey]),
      status: "received",
      submittedBy: str(a[map.submittedByKey]),
      submittedAt: sub.created_at ? new Date(sub.created_at).toISOString() : new Date().toISOString(),
      jotformSubmissionId: String(sub.submissionID),
      payload,
    };
  }
}
