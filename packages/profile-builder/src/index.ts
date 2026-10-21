/**
 * Profile builder (milestone 4). Drafts a PayrollProfile from a platform pull plus the
 * client's Box documents, and produces profile_questions wherever the two disagree.
 *
 * Phase 1 shipped here: the mechanical draft from the platform (step 1 of section 07).
 * Steps 2 to 4 (document extraction and comparison) call Claude with the Box documents
 * and are implemented in extract.ts once Box access is in place.
 */
import type { DraftRun, PayrollProfile, ProfileEmployee } from "@payroll-qa/engine";

export interface ProfileQuestion {
  employeeId?: string;
  field: string;
  platformValue?: string;
  documentValue?: string;
  sourceDocId?: string;
  question: string;
}

export interface ProfileDraft {
  profile: PayrollProfile;
  questions: ProfileQuestion[];
}

/** Step 1: mechanical draft from the platform. Every minister-looking line becomes a question. */
export function draftFromPlatform(clientId: string, clientName: string, run: DraftRun, registeredStates: string[]): ProfileDraft {
  const questions: ProfileQuestion[] = [];
  const employees: ProfileEmployee[] = run.employees.map((e, i) => {
    const housing = e.earnings.find((l) => l.type === "housing_allowance");
    const fica = e.taxes.socialSecurityEmployeeCents + e.taxes.medicareEmployeeCents + e.taxes.socialSecurityEmployerCents + e.taxes.medicareEmployerCents;
    const looksMinister = !!housing || (fica === 0 && e.grossCents > 0);
    const id = `emp_${i + 1}`;
    if (looksMinister) {
      questions.push({ employeeId: id, field: "is_minister", platformValue: housing ? `housing ${housing.amountCents / 100}` : "no FICA withheld", question: `${e.name}: confirm minister status and attach the board housing resolution with the annual amount and date.` });
    }
    if (!e.workState) questions.push({ employeeId: id, field: "work_state", question: `${e.name}: platform has no work location; confirm the work state.` });
    return {
      id,
      platformEmployeeId: e.platformEmployeeId,
      name: e.name,
      status: "active",
      hireDate: "",
      payType: e.payType,
      rateCents: e.rateCents,
      rateEffectiveDate: run.period.start,
      standardHours: e.payType === "hourly" ? Math.round(e.hours) : 0,
      workState: e.workState,
      isMinister: looksMinister,
      ficaExempt: looksMinister && fica === 0,
      fedWithholdingVoluntary: e.taxes.federalWithholdingCents > 0,
    };
  });
  for (const e of employees) {
    if (!e.hireDate) questions.push({ employeeId: e.id, field: "hire_date", question: `${e.name}: hire date is not in the payroll pull; take it from the employee record or offer letter.` });
  }
  const profile: PayrollProfile = {
    clientId,
    clientName,
    platform: run.platform,
    payFrequency: run.payFrequency,
    registeredStates,
    employees,
    housingAllowances: [],
    benefitElections: run.employees.flatMap((e, i) => e.deductions.filter((d) => d.planId).map((d) => {
      if (d.preTax === undefined) {
        questions.push({ employeeId: `emp_${i + 1}`, field: "benefit_pre_tax", platformValue: d.name, question: `${e.name}: the platform does not say whether ${d.name} is pre-tax; confirm from the plan summary.` });
      }
      return {
        employeeId: `emp_${i + 1}`, planId: d.planId!, planName: d.name, employeeDeductionCents: d.employeeCents, employerContributionCents: d.employerCents, preTax: d.preTax ?? true, effectiveFrom: run.period.start,
      };
    })),
    timeOffPolicies: Object.entries(run.platformAccruals ?? {}).map(([name, a]) => ({ policyName: name, accrualRateHours: a.rateHours, accrualBasis: "per_period", capHours: a.capHours, assignedEmployeeIds: employees.filter((x) => run.employees.find((r) => r.platformEmployeeId === x.platformEmployeeId)?.timeOffBalanceHours !== undefined).map((x) => x.id) })),
  };
  return { profile, questions };
}
