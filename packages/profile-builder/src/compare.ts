/**
 * Steps 3 and 4 of the profile builder, pure and tested: compare what the
 * platform says with what the documents say, and write a question for every
 * disagreement and every required document that is missing. Nothing here
 * repairs a value; a person chooses platform, document, or a corrected value.
 */
import type { PayrollProfile } from "@payroll-qa/engine";

/** One fact a document states, tied to the file it came from. */
export interface DocumentFact {
  boxFileId: string;
  boxFileName: string;
  kind: "housing_resolution" | "benefit_summary" | "offer_letter" | "pto_policy" | "comp_memo" | "other";
  /** Employee name as the document writes it, when the fact is about one person. */
  employeeName?: string;
  /** housing_resolution */
  annualHousingCents?: number;
  perPeriodHousingCents?: number;
  resolutionDate?: string; // ISO
  effectiveFrom?: string;
  effectiveTo?: string;
  /** offer_letter / comp_memo */
  payType?: "salary" | "hourly";
  rateCents?: number;
  rateEffectiveDate?: string;
  hireDate?: string;
  standardHours?: number;
  workState?: string;
  isMinister?: boolean;
  /** benefit_summary */
  planName?: string;
  employeeDeductionCents?: number;
  employerContributionCents?: number;
  preTax?: boolean;
  /** pto_policy */
  policyName?: string;
  accrualRateHours?: number;
  accrualBasis?: "per_period" | "per_hour" | "annual_grant";
  capHours?: number;
  /** verbatim excerpt supporting the fact */
  excerpt?: string;
}

export interface Question {
  platformEmployeeId?: string;
  field: string;
  platformValue?: string;
  documentValue?: string;
  sourceDocBoxFileId?: string;
  question: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Match a document's employee name to a profile employee: exact normalized match, or unique last-name match. */
export function matchEmployee(profile: PayrollProfile, name: string | undefined) {
  if (!name) return undefined;
  const n = norm(name);
  const exact = profile.employees.find((e) => norm(e.name) === n);
  if (exact) return exact;
  const parts = name.trim().split(/\s+/);
  const last = norm(parts[parts.length - 1] ?? "");
  const first = norm(parts[0] ?? "");
  const byLast = profile.employees.filter((e) => norm(e.name).endsWith(last) && (parts.length === 1 || norm(e.name).includes(first)));
  return byLast.length === 1 ? byLast[0] : undefined;
}

export function compareProfileToDocuments(profile: PayrollProfile, facts: DocumentFact[]): { questions: Question[]; housing: { platformEmployeeId: string; annualAmountCents: number; perPeriodAmountCents: number; resolutionDate: string; resolutionDocId: string; effectiveFrom: string; effectiveTo?: string }[] } {
  const questions: Question[] = [];
  const housing: ReturnType<typeof compareProfileToDocuments>["housing"] = [];
  const documentedHousing = new Set<string>();
  const documentedBenefit = new Set<string>();
  const documentedPto = new Set<string>();
  const sorted = facts.slice().sort((a, b) => a.boxFileId.localeCompare(b.boxFileId));

  for (const f of sorted) {
    const emp = matchEmployee(profile, f.employeeName);
    if (f.employeeName && !emp) {
      questions.push({ field: "unmatched_document", documentValue: f.employeeName, sourceDocBoxFileId: f.boxFileId, question: `${f.boxFileName} names "${f.employeeName}", who is not on the platform roster. Confirm who this is or that the document is stale.` });
      continue;
    }
    switch (f.kind) {
      case "housing_resolution": {
        if (!emp) break;
        documentedHousing.add(emp.id);
        if (!f.resolutionDate || f.annualHousingCents === undefined) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "housing_resolution", sourceDocBoxFileId: f.boxFileId, documentValue: f.excerpt, question: `${emp.name}: ${f.boxFileName} is a housing resolution but the ${!f.resolutionDate ? "resolution date" : "annual amount"} could not be read. Enter it from the document.` });
          break;
        }
        if (!emp.isMinister) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "is_minister", platformValue: "no", documentValue: "yes", sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${f.boxFileName} designates a housing allowance, but the platform does not treat ${emp.name} as a minister.` });
        }
        const perPeriod = f.perPeriodHousingCents;
        if (perPeriod === undefined) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "housing_per_period", documentValue: dollars(f.annualHousingCents), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${f.boxFileName} designates ${dollars(f.annualHousingCents)} per year but states no per-period split. Enter the per-period amount from the resolution.` });
        }
        housing.push({ platformEmployeeId: emp.platformEmployeeId, annualAmountCents: f.annualHousingCents, perPeriodAmountCents: perPeriod ?? 0, resolutionDate: f.resolutionDate, resolutionDocId: f.boxFileId, effectiveFrom: f.effectiveFrom ?? f.resolutionDate, effectiveTo: f.effectiveTo });
        break;
      }
      case "offer_letter":
      case "comp_memo": {
        if (!emp) break;
        if (f.rateCents !== undefined && f.rateCents !== emp.rateCents) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "rate_cents", platformValue: String(emp.rateCents), documentValue: String(f.rateCents), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: platform rate ${dollars(emp.rateCents)} differs from ${dollars(f.rateCents)} in ${f.boxFileName}${f.rateEffectiveDate ? ` (effective ${f.rateEffectiveDate})` : ""}.` });
        }
        if (f.payType && f.payType !== emp.payType) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "pay_type", platformValue: emp.payType, documentValue: f.payType, sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: platform pay type ${emp.payType} differs from ${f.payType} in ${f.boxFileName}.` });
        }
        if (f.hireDate && emp.hireDate && f.hireDate !== emp.hireDate) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "hire_date", platformValue: emp.hireDate, documentValue: f.hireDate, sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: platform hire date ${emp.hireDate} differs from ${f.hireDate} in ${f.boxFileName}.` });
        }
        if (f.hireDate && !emp.hireDate) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "hire_date", documentValue: f.hireDate, sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: hire date ${f.hireDate} comes from ${f.boxFileName}; the platform pull has none. Confirm.` });
        }
        if (f.workState && f.workState.toUpperCase() !== emp.workState) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "work_state", platformValue: emp.workState, documentValue: f.workState.toUpperCase(), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: platform work state ${emp.workState || "(none)"} differs from ${f.workState.toUpperCase()} in ${f.boxFileName}.` });
        }
        if (f.standardHours !== undefined && emp.payType === "hourly" && f.standardHours !== emp.standardHours) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "standard_hours", platformValue: String(emp.standardHours), documentValue: String(f.standardHours), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: standard hours ${emp.standardHours} on the platform differ from ${f.standardHours} in ${f.boxFileName}.` });
        }
        if (f.isMinister !== undefined && f.isMinister !== emp.isMinister) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "is_minister", platformValue: emp.isMinister ? "yes" : "no", documentValue: f.isMinister ? "yes" : "no", sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${f.boxFileName} ${f.isMinister ? "describes a ministerial role" : "describes a non-ministerial role"}; the platform says otherwise.` });
        }
        break;
      }
      case "benefit_summary": {
        if (!emp || !f.planName) break;
        documentedBenefit.add(emp.id);
        const el = profile.benefitElections.find((b) => b.employeeId === emp.id && (norm(b.planName) === norm(f.planName!) || norm(b.planId) === norm(f.planName!)));
        if (!el) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "benefit_missing", documentValue: f.planName, sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${f.boxFileName} enrols ${emp.name} in ${f.planName}, which is not deducted on the platform.` });
          break;
        }
        if (f.employeeDeductionCents !== undefined && f.employeeDeductionCents !== el.employeeDeductionCents) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "benefit_employee_deduction", platformValue: dollars(el.employeeDeductionCents), documentValue: dollars(f.employeeDeductionCents), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${el.planName} employee deduction ${dollars(el.employeeDeductionCents)} on the platform vs ${dollars(f.employeeDeductionCents)} in ${f.boxFileName}.` });
        }
        if (f.employerContributionCents !== undefined && f.employerContributionCents !== el.employerContributionCents) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "benefit_employer_contribution", platformValue: dollars(el.employerContributionCents), documentValue: dollars(f.employerContributionCents), sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${el.planName} employer contribution ${dollars(el.employerContributionCents)} on the platform vs ${dollars(f.employerContributionCents)} in ${f.boxFileName}.` });
        }
        if (f.preTax !== undefined && f.preTax !== el.preTax) {
          questions.push({ platformEmployeeId: emp.platformEmployeeId, field: "benefit_pre_tax", platformValue: el.preTax ? "pre-tax" : "post-tax", documentValue: f.preTax ? "pre-tax" : "post-tax", sourceDocBoxFileId: f.boxFileId, question: `${emp.name}: ${el.planName} is ${el.preTax ? "pre-tax" : "post-tax"} on the platform and ${f.preTax ? "pre-tax" : "post-tax"} in ${f.boxFileName}.` });
        }
        break;
      }
      case "pto_policy": {
        if (!f.policyName) break;
        documentedPto.add(norm(f.policyName));
        const pol = profile.timeOffPolicies.find((p) => norm(p.policyName) === norm(f.policyName!));
        if (!pol) {
          questions.push({ field: "pto_policy_missing", documentValue: f.policyName, sourceDocBoxFileId: f.boxFileId, question: `${f.boxFileName} describes a policy "${f.policyName}" that is not configured on the platform.` });
          break;
        }
        if (f.accrualRateHours !== undefined && f.accrualRateHours !== pol.accrualRateHours) {
          questions.push({ field: "pto_accrual_rate", platformValue: String(pol.accrualRateHours), documentValue: String(f.accrualRateHours), sourceDocBoxFileId: f.boxFileId, question: `${pol.policyName}: platform accrues ${pol.accrualRateHours}h, ${f.boxFileName} says ${f.accrualRateHours}h${f.accrualBasis ? ` ${f.accrualBasis.replace("_", " ")}` : ""}.` });
        }
        if (f.capHours !== undefined && f.capHours !== pol.capHours) {
          questions.push({ field: "pto_cap", platformValue: String(pol.capHours ?? "none"), documentValue: String(f.capHours), sourceDocBoxFileId: f.boxFileId, question: `${pol.policyName}: platform cap ${pol.capHours ?? "none"}, ${f.boxFileName} says ${f.capHours}h.` });
        }
        break;
      }
      case "other":
        break;
    }
  }

  // step 4: every minister without a resolution, every housing line without a resolution, every employee with no benefit or PTO source document
  for (const e of profile.employees) {
    if (e.status !== "active") continue;
    if (e.isMinister && !documentedHousing.has(e.id)) {
      questions.push({ platformEmployeeId: e.platformEmployeeId, field: "housing_resolution", question: `${e.name} is a minister on the platform and no board housing resolution was found in Box. Obtain the resolution (annual amount, per-period split, date, renewal) before signing.` });
    }
    if (profile.benefitElections.some((b) => b.employeeId === e.id) && !documentedBenefit.has(e.id)) {
      questions.push({ platformEmployeeId: e.platformEmployeeId, field: "benefit_source", question: `${e.name} has benefit deductions on the platform and no enrollment form or plan summary in Box names them. Attach the source document or confirm the amounts.` });
    }
  }
  for (const pol of profile.timeOffPolicies) {
    if (!documentedPto.has(norm(pol.policyName))) {
      questions.push({ field: "pto_source", platformValue: pol.policyName, question: `No PTO policy document in Box describes "${pol.policyName}". Attach the policy or confirm ${pol.accrualRateHours}h ${pol.accrualBasis.replace("_", " ")}${pol.capHours !== undefined ? `, cap ${pol.capHours}h` : ""}.` });
    }
  }
  return { questions: dedupe(questions), housing };
}

function dedupe(qs: Question[]): Question[] {
  const seen = new Set<string>();
  return qs.filter((q) => {
    const k = `${q.platformEmployeeId ?? ""}|${q.field}|${q.question}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
