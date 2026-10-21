/**
 * A5: a request still in status `received` whose effective date has arrived
 * (inside this period, or earlier and never applied) blocks the run.
 */
import type { Check } from "../types";

export const A5: Check = {
  code: "A5",
  family: "A",
  title: "Received requests effective by period end are not yet applied",
  severity: "block",
  run(ctx) {
    const { end } = ctx.draft.period;
    return ctx.ledgerActive
      .filter((c) => c.status === "received" && c.effectiveDate <= end)
      .map((c) => {
        const prof = c.employeeId ? ctx.profileById.get(c.employeeId) : undefined;
        return {
          checkCode: "A5",
          severity: "block" as const,
          employeeId: c.employeeId,
          employeeName: prof?.name,
          expected: "request applied to profile before the run",
          actual: `status received (submitted ${c.submittedAt} by ${c.submittedBy})`,
          sourceOfExpected: "ledger" as const,
          requestId: c.id,
          description: `Request ${c.id} (${c.type}, effective ${c.effectiveDate}) has not been applied.`,
        };
      });
  },
};
