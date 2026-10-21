/**
 * B2: headcount changed with no hire or termination request. A profile that
 * already records the employee as terminated or on leave explains a drop; a
 * new employee always needs a new_hire request.
 */
import type { Check, Exception } from "../types";
import { nameFor, profId, requestsFor } from "./_b";

export const B2: Check = {
  code: "B2",
  family: "B",
  title: "Headcount changed with no hire or termination request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      if (ctx.priorByPlatformId.has(d.platformEmployeeId)) continue;
      const hire = requestsFor(ctx, d.platformEmployeeId).some((c) => c.type === "new_hire");
      if (!hire) {
        out.push({
          checkCode: "B2",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: "new_hire request on the ledger",
          actual: "employee appears in draft, absent from prior run, no request",
          sourceOfExpected: "prior_run",
          description: "Employee added to payroll with no new_hire request.",
        });
      }
    }
    for (const p of ctx.prior.employees) {
      if (ctx.draftByPlatformId.has(p.platformEmployeeId)) continue;
      const prof = ctx.profileByPlatformId.get(p.platformEmployeeId);
      if (prof && prof.status !== "active") continue; // profile records the leave or termination
      const term = ctx.ledgerActive.some((c) => c.employeeId === prof?.id && c.type === "termination");
      if (!term) {
        out.push({
          checkCode: "B2",
          severity: "block",
          employeeId: prof?.id,
          employeeName: prof?.name ?? p.name,
          expected: "termination request on the ledger",
          actual: "employee in prior run, absent from draft, no request",
          sourceOfExpected: "prior_run",
          description: "Employee dropped from payroll with no termination request.",
        });
      }
    }
    return out;
  },
};
