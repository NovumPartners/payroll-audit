/**
 * C5: benefit deductions and employer contributions match the elections
 * active in the period, including pre-tax treatment. A plan on the draft with
 * no election, or an election with no line, is a block. Tax treatment the
 * platform does not report is stated as unverified once per run.
 */
import type { Check, Exception } from "../types";
import { dollars } from "../context";

export const C5: Check = {
  code: "C5",
  family: "C",
  title: "Benefit deductions and contributions match elections",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    let unreported = 0;
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const elections = ctx.electionsByEmployee.get(p.id) ?? [];
      const pendingPlans = new Set(
        ctx.ledgerInPeriod
          .filter((c) => c.employeeId === p.id && c.payload.kind === "benefit_change")
          .map((c) => (c.payload.kind === "benefit_change" ? c.payload.planId : "")),
      );
      for (const el of elections) {
        if (pendingPlans.has(el.planId)) continue;
        const line = d.deductions.find((x) => x.planId === el.planId);
        if (!line) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `${el.planName} employee ${dollars(el.employeeDeductionCents)} / employer ${dollars(el.employerContributionCents)}`,
            actual: "plan missing from draft",
            sourceOfExpected: "profile",
            description: "An elected benefit is not on the draft.",
          });
          continue;
        }
        const problems: string[] = [];
        if (line.employeeCents !== el.employeeDeductionCents) problems.push(`employee ${dollars(line.employeeCents)}`);
        if (line.employerCents !== el.employerContributionCents) problems.push(`employer ${dollars(line.employerCents)}`);
        if (line.preTax === undefined) unreported++;
        else if (line.preTax !== el.preTax) problems.push(line.preTax ? "pre-tax" : "post-tax");
        if (problems.length) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `${el.planName} employee ${dollars(el.employeeDeductionCents)} / employer ${dollars(el.employerContributionCents)}, ${el.preTax ? "pre-tax" : "post-tax"}`,
            actual: `${el.planName} ${problems.join(", ")}`,
            sourceOfExpected: "profile",
            description: "Benefit amounts or tax treatment differ from the election on the profile.",
          });
        }
      }
      for (const line of d.deductions) {
        if (line.planId && !elections.some((el) => el.planId === line.planId) && !pendingPlans.has(line.planId)) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `no ${line.name} deduction (no election on profile)`,
            actual: `${line.name} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}`,
            sourceOfExpected: "profile",
            description: "A deduction is running with no election on the profile.",
          });
        }
      }
    }
    if (unreported > 0) {
      out.push({
        checkCode: "C5",
        severity: "info",
        expected: "pre-tax treatment of every elected benefit confirmed",
        actual: `${unreported} benefit line${unreported === 1 ? "" : "s"} with tax treatment not reported by the platform`,
        sourceOfExpected: "platform_rule",
        description: "The platform pull does not say whether these deductions are pre-tax; amounts were checked, treatment was not.",
      });
    }
    return out;
  },
};
