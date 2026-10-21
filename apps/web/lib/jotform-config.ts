/**
 * JotForm form registry. The form ids and field names are an open item Brad
 * supplies (spec section 10); they are configured as JSON in JOTFORM_FORMS so
 * no deploy is needed when a form is added. See config/jotform-forms.example.json.
 */
import type { JotFormFieldMap } from "@payroll-qa/adapters";
import type { ChangeType } from "@payroll-qa/engine";

const TYPES = new Set<ChangeType>(["new_hire", "termination", "rate_change", "housing_change", "benefit_change", "time_off_change", "one_time_pay", "deduction_change", "schedule_change"]);

export function parseJotformForms(json: string | undefined): JotFormFieldMap[] {
  if (!json) return [];
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error("JOTFORM_FORMS must be a JSON array");
  return raw.map((m, i) => {
    const r = m as Partial<JotFormFieldMap>;
    for (const k of ["formId", "type", "clientKey", "effectiveDateKey", "submittedByKey", "fields"] as const) {
      if (r[k] === undefined || r[k] === null || r[k] === "") throw new Error(`JOTFORM_FORMS[${i}] is missing ${k}`);
    }
    if (!TYPES.has(r.type as ChangeType)) throw new Error(`JOTFORM_FORMS[${i}] has unknown type ${String(r.type)}`);
    return { formId: String(r.formId), type: r.type as ChangeType, clientKey: r.clientKey!, employeeKey: r.employeeKey, effectiveDateKey: r.effectiveDateKey!, submittedByKey: r.submittedByKey!, fields: r.fields as Record<string, string> };
  });
}
