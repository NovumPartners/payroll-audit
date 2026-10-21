/**
 * C6: the platform's accrual policy matches the profile (rate and cap, both
 * directions, and presence), and each assigned employee's balance is within
 * one accrual period of the balance computed from the prior balance, the
 * policy, and the hours on the draft.
 */
import type { Check, Exception } from "../types";
import { earningHours } from "../context";

export const C6: Check = {
  code: "C6",
  family: "C",
  title: "Time-off accrual setup and balances",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    const accruals = ctx.draft.platformAccruals;
    for (const pol of ctx.profile.timeOffPolicies) {
      const polText = `${pol.policyName}: ${pol.accrualRateHours}h ${pol.accrualBasis}${pol.capHours !== undefined ? `, cap ${pol.capHours}h` : ", no cap"}`;
      if (accruals) {
        const plat = accruals[pol.policyName];
        if (!plat) {
          out.push({
            checkCode: "C6",
            severity: "review",
            expected: polText,
            actual: `${pol.policyName} not configured on the platform`,
            sourceOfExpected: "profile",
            description: "A time-off policy on the profile is missing from the platform.",
          });
        } else if (plat.rateHours !== pol.accrualRateHours || (plat.capHours ?? null) !== (pol.capHours ?? null)) {
          out.push({
            checkCode: "C6",
            severity: "review",
            expected: polText,
            actual: `${pol.policyName}: ${plat.rateHours}h${plat.capHours !== undefined ? `, cap ${plat.capHours}h` : ", no cap"}`,
            sourceOfExpected: "profile",
            description: "Platform accrual policy differs from the profile.",
          });
        }
      }
      if (!ctx.prior) continue;
      for (const empId of pol.assignedEmployeeIds) {
        const p = ctx.profileById.get(empId);
        const d = p ? ctx.draftByPlatformId.get(p.platformEmployeeId) : undefined;
        const prior = p ? ctx.priorByPlatformId.get(p.platformEmployeeId) : undefined;
        if (!p || !d || !prior || d.timeOffBalanceHours === undefined || prior.timeOffBalanceHours === undefined) continue;
        const accrued =
          pol.accrualBasis === "per_period" ? pol.accrualRateHours : pol.accrualBasis === "per_hour" ? pol.accrualRateHours * d.hours : 0;
        const used = earningHours(d, "pto");
        let expected = prior.timeOffBalanceHours + accrued - used;
        if (pol.capHours !== undefined) expected = Math.min(expected, pol.capHours);
        const tolerance = accrued > 0 ? accrued : ctx.config.accrualToleranceHours;
        if (Math.abs(d.timeOffBalanceHours - expected) > tolerance + 1e-9) {
          out.push({
            checkCode: "C6",
            severity: "review",
            employeeId: p.id,
            employeeName: p.name,
            expected: `balance within ${Number(tolerance.toFixed(2))}h of ${expected.toFixed(1)}h (prior ${prior.timeOffBalanceHours.toFixed(1)}h + ${accrued.toFixed(1)}h accrued - ${used.toFixed(1)}h used)`,
            actual: `balance ${d.timeOffBalanceHours.toFixed(1)}h`,
            sourceOfExpected: "profile",
            description: "Time-off balance is outside one accrual period of the policy-computed balance.",
          });
        }
      }
    }
    return out;
  },
};
