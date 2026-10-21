import { dollars, type PayrollProfile } from "@payroll-qa/engine";

/** The signed Payroll Profile as filed to Box: everything the engine will hold the platform to. */
export function renderProfileMarkdown(p: PayrollProfile, signerName: string): string {
  const L: string[] = [];
  L.push(`# Payroll Profile: ${p.clientName}`);
  L.push("");
  L.push(`Platform ${p.platform}. Pay frequency ${p.payFrequency}. Registered states ${p.registeredStates.join(", ") || "none"}. Signed by ${signerName} at ${p.signedAt ?? ""}.${p.housingEarningTypeConfirmedExcluded ? " Housing earning type confirmed excluded from taxable wages." : ""}`);
  L.push("");
  L.push("## Employees");
  L.push("");
  L.push("| Name | Platform id | Status | Hired | Pay type | Rate | Standard hours | State | Minister | FICA exempt | Federal withholding voluntary |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const e of p.employees) L.push(`| ${e.name} | ${e.platformEmployeeId} | ${e.status} | ${e.hireDate} | ${e.payType} | ${dollars(e.rateCents)} | ${e.standardHours || ""} | ${e.workState} | ${e.isMinister ? "yes" : "no"} | ${e.ficaExempt ? "yes" : "no"} | ${e.fedWithholdingVoluntary ? "yes" : "no"} |`);
  const name = (id: string) => p.employees.find((e) => e.id === id)?.name ?? id;
  L.push("");
  L.push("## Housing designations");
  L.push("");
  if (!p.housingAllowances.length) L.push("None.");
  else {
    L.push("| Minister | Annual | Per period | Resolution date | Effective | Resolution file |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const h of p.housingAllowances) L.push(`| ${name(h.employeeId)} | ${dollars(h.annualAmountCents)} | ${dollars(h.perPeriodAmountCents)} | ${h.resolutionDate} | ${h.effectiveFrom}${h.effectiveTo ? ` to ${h.effectiveTo}` : " onward"} | ${h.resolutionDocId ?? ""} |`);
  }
  L.push("");
  L.push("## Benefit elections");
  L.push("");
  if (!p.benefitElections.length) L.push("None.");
  else {
    L.push("| Employee | Plan | Employee deduction | Employer contribution | Treatment | Effective |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const b of p.benefitElections) L.push(`| ${name(b.employeeId)} | ${b.planName} | ${dollars(b.employeeDeductionCents)} | ${dollars(b.employerContributionCents)} | ${b.preTax ? "pre-tax" : "post-tax"} | ${b.effectiveFrom}${b.effectiveTo ? ` to ${b.effectiveTo}` : ""} |`);
  }
  L.push("");
  L.push("## Time-off policies");
  L.push("");
  if (!p.timeOffPolicies.length) L.push("None.");
  else {
    L.push("| Policy | Accrual | Cap | Assigned |");
    L.push("| --- | --- | --- | --- |");
    for (const t of p.timeOffPolicies) L.push(`| ${t.policyName} | ${t.accrualRateHours}h ${t.accrualBasis.replace("_", " ")} | ${t.capHours ?? ""} | ${t.assignedEmployeeIds.map(name).join(", ")} |`);
  }
  return L.join("\n");
}
