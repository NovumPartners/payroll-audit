/**
 * D2: scheduled items due this period with no request: an anniversary step
 * increase, a benefit eligibility date, a housing designation expiring within
 * the warning window, and an accrual cap newly reached.
 */
import type { Check, Exception } from "../types.js";
import { daysBetween, inPeriod } from "../context.js";

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The anniversary of hireDate that falls inside [start, end], if any. A Feb 29 hire observes Feb 28 in a common year. */
export function anniversaryInPeriod(hireDate: string, start: string, end: string): string | undefined {
  const y0 = Number(start.slice(0, 4));
  const mmdd = hireDate.slice(5);
  for (const y of [y0, y0 + 1]) {
    const day = mmdd === "02-29" && !isLeap(y) ? "02-28" : mmdd;
    const candidate = `${y}-${day}`;
    if (candidate > hireDate && inPeriod(candidate, start, end)) return candidate;
  }
  return undefined;
}

export const D2: Check = {
  code: "D2",
  family: "D",
  title: "Scheduled items due with no request",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    const { start, end } = ctx.draft.period;
    const reqs = ctx.ledgerInPeriod;
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      if (p.anniversaryStepIncrease) {
        const ann = anniversaryInPeriod(p.hireDate, start, end);
        if (ann && !reqs.some((c) => c.employeeId === p.id && c.type === "rate_change")) {
          out.push({
            checkCode: "D2",
            severity: "review",
            employeeId: p.id,
            employeeName: p.name,
            expected: `rate_change request for anniversary step increase on ${ann}`,
            actual: "no request",
            sourceOfExpected: "profile",
            description: "Profile marks this employee for an anniversary step increase; none was submitted.",
          });
        }
      }
      if (p.benefitEligibilityDate && inPeriod(p.benefitEligibilityDate, start, end)) {
        if (!reqs.some((c) => c.employeeId === p.id && c.type === "benefit_change")) {
          out.push({
            checkCode: "D2",
            severity: "review",
            employeeId: p.id,
            employeeName: p.name,
            expected: `benefit elections by eligibility date ${p.benefitEligibilityDate}`,
            actual: "no benefit_change request",
            sourceOfExpected: "profile",
            description: "Employee becomes benefit-eligible this period and no election was submitted.",
          });
        }
      }
      const h = ctx.housingByEmployee.get(p.id);
      if (h?.effectiveTo) {
        const daysLeft = daysBetween(ctx.asOf, h.effectiveTo);
        if (daysLeft >= 0 && daysLeft <= ctx.config.housingExpiryWarnDays) {
          if (!ctx.ledgerActive.some((c) => c.employeeId === p.id && c.type === "housing_change" && c.effectiveDate > h.effectiveTo!)) {
            out.push({
              checkCode: "D2",
              severity: "review",
              employeeId: p.id,
              employeeName: p.name,
              expected: `renewed housing designation before ${h.effectiveTo}`,
              actual: `designation expires in ${daysLeft} days, no housing_change request for the renewal`,
              sourceOfExpected: "profile",
              description: "Housing designation expires soon; a new board resolution is needed.",
            });
          }
        }
      }
    }
    for (const pol of ctx.profile.timeOffPolicies) {
      if (pol.capHours === undefined) continue;
      for (const empId of pol.assignedEmployeeIds) {
        const p = ctx.profileById.get(empId);
        const d = p ? ctx.draftByPlatformId.get(p.platformEmployeeId) : undefined;
        if (!p || !d || d.timeOffBalanceHours === undefined) continue;
        if (d.timeOffBalanceHours < pol.capHours) continue;
        const prior = ctx.priorByPlatformId.get(p.platformEmployeeId);
        const alreadyAtCap = prior?.timeOffBalanceHours !== undefined && prior.timeOffBalanceHours >= pol.capHours;
        if (alreadyAtCap) continue; // reported the period it was reached
        out.push({
          checkCode: "D2",
          severity: "review",
          employeeId: p.id,
          employeeName: p.name,
          expected: `balance under cap ${pol.capHours}h`,
          actual: `balance ${d.timeOffBalanceHours}h at cap, accrual stops`,
          sourceOfExpected: "profile",
          description: "Employee has reached the accrual cap this period; tell the client.",
        });
      }
    }
    return out;
  },
};
