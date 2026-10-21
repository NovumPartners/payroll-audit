/**
 * JotForm webhook -> ChangeRequest.
 * JotForm posts multipart form data with `rawRequest` (JSON string of answers keyed by
 * field unique names, e.g. "q3_employeeName") plus `formID`, `submissionID`, `ip`.
 * Each Novum form is registered here with a field map, so a renamed field fails
 * mapping loudly instead of producing a half-filled request.
 *
 * JotForm does not sign webhook deliveries. The webhook URL carries a shared
 * secret segment that the route compares in constant time (`verifySharedSecret`),
 * and the form id must be registered. Idempotency is the unique index on
 * jotform_submission_id in the database: a duplicate delivery is a no-op.
 */
import { timingSafeEqual } from "node:crypto";
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

const cents = (v: unknown): number => {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "") throw new Error("Amount is blank");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Amount is not a number: ${String(v)}`);
  return Math.round(n * 100);
};
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v)).trim();
const bool = (v: unknown): boolean => /^(yes|true|1|y)$/i.test(str(v));
const required = (v: unknown, field: string): string => {
  const s = str(v);
  if (!s) throw new Error(`Required field ${field} is blank`);
  return s;
};

const FREQUENCIES = new Set<PayFrequency>(["weekly", "biweekly", "semimonthly", "monthly"]);

/** JotForm date widgets arrive as {month, day, year} or "MM/DD/YYYY" or "YYYY-MM-DD". */
export function normalizeDate(v: unknown): string {
  if (v && typeof v === "object" && "year" in (v as Record<string, unknown>)) {
    const o = v as Record<string, string>;
    return validDate(`${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`);
  }
  const s = str(v);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return validDate(`${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return validDate(s.slice(0, 10));
  throw new Error(`Unrecognized date: ${s}`);
}

function validDate(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) throw new Error(`Invalid calendar date: ${iso}`);
  return iso;
}

/** Constant-time comparison of the URL secret against the configured one. */
export function verifySharedSecret(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class JotFormMapper implements WebhookMapper {
  private byForm: Map<string, JotFormFieldMap>;
  constructor(
    maps: JotFormFieldMap[],
    private resolve: { clientId: (key: string) => string | undefined; employeeId: (clientId: string, key: string) => string | undefined },
  ) {
    this.byForm = new Map(maps.map((m) => [m.formId, m]));
  }

  knowsForm(formId: string): boolean {
    return this.byForm.has(String(formId));
  }

  toChangeRequest(raw: unknown): ChangeRequest {
    const sub = raw as JotFormRawSubmission;
    const map = this.byForm.get(String(sub.formID));
    if (!map) throw new Error(`No field map for JotForm form ${sub.formID}`);
    const a: Record<string, unknown> = typeof sub.rawRequest === "string" ? JSON.parse(sub.rawRequest) : sub.rawRequest;
    const f = (k: string) => {
      const key = map.fields[k];
      if (!key) throw new Error(`Form ${map.formId} has no mapping for ${k}`);
      return a[key];
    };
    const clientKey = required(a[map.clientKey], map.clientKey);
    const clientId = this.resolve.clientId(clientKey);
    if (!clientId) throw new Error(`Unknown client "${clientKey}"`);
    const employeeId = map.employeeKey ? this.resolve.employeeId(clientId, str(a[map.employeeKey])) : undefined;
    if (map.employeeKey && !employeeId) throw new Error(`Unknown employee "${str(a[map.employeeKey])}" for client ${clientId}`);

    let payload: ChangePayload;
    switch (map.type) {
      case "new_hire":
        payload = { kind: "new_hire", payType: (required(f("payType"), "payType").toLowerCase().startsWith("hour") ? "hourly" : "salary") as PayType, rateCents: cents(f("rate")), hireDate: normalizeDate(f("hireDate")) };
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
        payload = { kind: "benefit_change", planId: required(f("planId"), "planId"), employeeDeductionCents: cents(f("employeeDeduction")), employerContributionCents: cents(f("employerContribution")) };
        break;
      case "time_off_change": {
        const cap = str(f("capHours"));
        payload = { kind: "time_off_change", policyName: required(f("policyName"), "policyName"), accrualRateHours: Number(required(f("accrualRateHours"), "accrualRateHours")), capHours: cap ? Number(cap) : undefined };
        if (!Number.isFinite(payload.accrualRateHours) || (payload.capHours !== undefined && !Number.isFinite(payload.capHours))) throw new Error("Accrual hours are not numbers");
        break;
      }
      case "one_time_pay": {
        const type = required(f("earningType"), "earningType").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        payload = { kind: "one_time_pay", earningType: type, amountCents: cents(f("amount")), description: str(f("description")) || undefined };
        break;
      }
      case "deduction_change":
        payload = { kind: "deduction_change", deductionName: required(f("deductionName"), "deductionName"), amountCents: cents(f("amount")) };
        break;
      case "schedule_change": {
        const freq = required(f("payFrequency"), "payFrequency").toLowerCase().replace(/[^a-z]/g, "") as PayFrequency;
        if (!FREQUENCIES.has(freq)) throw new Error(`Unknown pay frequency: ${freq}`);
        payload = { kind: "schedule_change", payFrequency: freq };
        break;
      }
    }

    const created = sub.created_at ? Date.parse(sub.created_at.replace(" ", "T") + (sub.created_at.includes("Z") || /[+-]\d\d:?\d\d$/.test(sub.created_at) ? "" : "Z")) : NaN;
    return {
      id: `jf_${sub.submissionID}`,
      clientId,
      employeeId,
      type: map.type,
      effectiveDate: normalizeDate(a[map.effectiveDateKey]),
      status: "received",
      submittedBy: required(a[map.submittedByKey], map.submittedByKey),
      submittedAt: Number.isNaN(created) ? new Date().toISOString() : new Date(created).toISOString(),
      jotformSubmissionId: String(sub.submissionID),
      payload,
    };
  }
}
