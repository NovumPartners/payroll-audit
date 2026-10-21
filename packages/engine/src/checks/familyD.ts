/** Family D: Platform and calendar rules. Things nobody submitted. */
import type { Check, Exception } from "../types.js";
import { daysBetween, inPeriod } from "../context.js";

export const D1: Check = {
  code: "D1",
  family: "D",
  title: "Platform blockers and warnings",
  severity: "block",
  run(ctx) {
    return ctx.draft.blockers.map<Exception>((b) => {
      const p = b.employeeId ? ctx.profileByPlatformId.get(b.employeeId) : undefined;
      return {
        checkCode: "D1",
        severity: "block",
        employeeId: p?.id,
        employeeName: p?.name,
        expected: "no platform blockers",
        actual: `${b.code}: ${b.message}`,
        sourceOfExpected: "platform_rule",
        description: "The platform reports a blocker that will stop or delay submission.",
      };
    });
  },
};

function anniversaryInPeriod(hireDate: string, start: string, end: string): string | undefined {
  const y0 = Number(start.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const candidate = `${y}${hireDate.slice(4)}`;
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
          if (!reqs.some((c) => c.employeeId === p.id && c.type === "housing_change")) {
            out.push({
              checkCode: "D2",
              severity: "review",
              employeeId: p.id,
              employeeName: p.name,
              expected: `renewed housing designation before ${h.effectiveTo}`,
              actual: `designation expires in ${daysLeft} days, no housing_change request`,
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
        const p = ctx.profile.employees.find((e) => e.id === empId);
        const d = p ? ctx.draftByPlatformId.get(p.platformEmployeeId) : undefined;
        if (!p || !d || d.timeOffBalanceHours === undefined) continue;
        if (d.timeOffBalanceHours >= pol.capHours) {
          out.push({
            checkCode: "D2",
            severity: "info",
            employeeId: p.id,
            employeeName: p.name,
            expected: `balance under cap ${pol.capHours}h`,
            actual: `balance ${d.timeOffBalanceHours}h at cap, accrual stops`,
            sourceOfExpected: "profile",
            description: "Employee has reached the accrual cap; the client may want to know.",
          });
        }
      }
    }
    return out;
  },
};

export const familyD: Check[] = [D1, D2];
