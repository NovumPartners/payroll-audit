/**
 * B5: a deduction or employer contribution changed, appeared, or disappeared
 * since the prior period with no benefit_change or deduction_change request.
 */
import type { Check, DeductionLine, Exception } from "../types.js";
import { dollars } from "../context.js";
import { nameFor, profId, requestsFor } from "./_b.js";

function same(a: DeductionLine, b: DeductionLine): boolean {
  return (!!a.planId && a.planId === b.planId) || a.name === b.name;
}

export const B5: Check = {
  code: "B5",
  family: "B",
  title: "Deduction or contribution changed with no benefit request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p) continue;
      const reqs = requestsFor(ctx, d.platformEmployeeId).filter((c) => c.type === "benefit_change" || c.type === "deduction_change");
      const explained = (line: DeductionLine) =>
        reqs.some(
          (c) =>
            (c.payload.kind === "benefit_change" && c.payload.planId === line.planId) ||
            (c.payload.kind === "deduction_change" && c.payload.deductionName === line.name),
        );
      for (const line of d.deductions) {
        const prior = p.deductions.find((x) => same(x, line));
        const changed = !prior || prior.employeeCents !== line.employeeCents || prior.employerCents !== line.employerCents;
        if (!changed || explained(line)) continue;
        out.push({
          checkCode: "B5",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: prior
            ? `${line.name} employee ${dollars(prior.employeeCents)} / employer ${dollars(prior.employerCents)} (prior period)`
            : `no ${line.name} deduction (prior period)`,
          actual: `${line.name} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}`,
          sourceOfExpected: "prior_run",
          description: "Deduction or employer contribution changed with no request.",
        });
      }
      for (const prior of p.deductions) {
        if (d.deductions.some((x) => same(x, prior)) || explained(prior)) continue;
        if (prior.employeeCents === 0 && prior.employerCents === 0) continue;
        out.push({
          checkCode: "B5",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: `${prior.name} employee ${dollars(prior.employeeCents)} / employer ${dollars(prior.employerCents)} (prior period)`,
          actual: `${prior.name} not on draft`,
          sourceOfExpected: "prior_run",
          description: "A deduction from the prior period is missing with no request.",
        });
      }
    }
    return out;
  },
};
