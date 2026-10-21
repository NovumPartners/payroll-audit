/**
 * B1: recurring gross moved from the prior period with no request explaining
 * it. Salaried employees are compared on recurring earning lines (regular,
 * overtime, housing, pto, holiday, sick) so a one-time bonus in either period
 * does not read as a move; one-time types are B4's job. Requests explain a
 * move by amount where the amount is knowable (rate change, housing change)
 * and suppress the comparison where the period is partial (hire,
 * termination, schedule change, a rate change inside the prior period).
 * Hourly employees are compared on rate; hours are B3.
 */
import type { Check, Exception } from "../types.js";
import { dollars, earning, perPeriodSalary, recurringGross } from "../context.js";
import { nameFor, profId, requestsFor, requestsInPrior } from "./_b.js";

export const B1: Check = {
  code: "B1",
  family: "B",
  title: "Gross moved with no change request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    const freq = ctx.draft.payFrequency;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p) continue; // B2 handles adds
      const prof = ctx.profileByPlatformId.get(d.platformEmployeeId);
      const reqs = requestsFor(ctx, d.platformEmployeeId);
      if (d.payType === "hourly" || p.payType === "hourly") {
        if (d.rateCents !== p.rateCents && !reqs.some((c) => c.type === "rate_change" || c.type === "new_hire")) {
          out.push({
            checkCode: "B1",
            severity: "block",
            employeeId: profId(ctx, d),
            employeeName: nameFor(ctx, d),
            expected: `hourly rate ${dollars(p.rateCents)} (prior period)`,
            actual: `hourly rate ${dollars(d.rateCents)}`,
            sourceOfExpected: "prior_run",
            description: "Hourly rate changed with no rate_change request on the ledger.",
          });
        }
        continue; // hours variance is B3
      }
      // partial periods on either side are explained by their own checks
      if (reqs.some((c) => c.type === "new_hire" || c.type === "termination" || c.type === "schedule_change")) continue;
      if (requestsInPrior(ctx, d.platformEmployeeId).some((c) => c.type === "rate_change" || c.type === "new_hire")) continue;
      if (prof && prof.hireDate > ctx.prior.period.start) continue; // prior period was the first, prorated
      if (prof?.terminationDate && prof.terminationDate <= ctx.draft.period.end) continue; // A4 owns the final period

      let explained = 0;
      let unknown = false;
      for (const c of reqs) {
        if (c.payload.kind === "rate_change") {
          if (c.effectiveDate > ctx.draft.period.start) {
            unknown = true; // mid-period: A2 computes the exact prorated expectation
            break;
          }
          const oldRate = c.payload.previousRateCents ?? (prof && prof.rateCents !== c.payload.newRateCents ? prof.rateCents : undefined);
          if (oldRate === undefined) {
            unknown = true;
            break;
          }
          explained += perPeriodSalary(c.payload.newRateCents, freq) - perPeriodSalary(oldRate, freq);
        } else if (c.payload.kind === "housing_change") {
          explained += c.payload.perPeriodAmountCents - earning(p, "housing_allowance");
        }
      }
      if (unknown) continue; // A2 owns a mid-period or unverifiable rate change
      const before = recurringGross(p);
      const now = recurringGross(d);
      const delta = Math.abs(now - before - explained);
      const threshold = Math.max(ctx.config.grossMoveMinCents, Math.round(before * ctx.config.grossMovePct));
      if (delta > threshold) {
        out.push({
          checkCode: "B1",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: `recurring gross within ${dollars(threshold)} of ${dollars(before + explained)}${explained ? ` (prior ${dollars(before)} plus ${dollars(explained)} from requests)` : ""}`,
          actual: `recurring gross ${dollars(now)}`,
          sourceOfExpected: "prior_run",
          description: "Recurring gross pay moved with no change request on the ledger explaining the amount.",
        });
      }
    }
    return out;
  },
};
