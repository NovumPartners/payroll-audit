/** B6: net pay below half of the prior period with no request of any kind. */
import type { Check, Exception } from "../types";
import { dollars } from "../context";
import { nameFor, profId, requestsFor } from "./_b";

export const B6: Check = {
  code: "B6",
  family: "B",
  title: "Net pay dropped sharply",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p || p.netCents <= 0) continue;
      if (d.netCents < p.netCents * ctx.config.netDropPct && requestsFor(ctx, d.platformEmployeeId).length === 0) {
        out.push({
          checkCode: "B6",
          severity: "review",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: `net at or above ${dollars(Math.ceil(p.netCents * ctx.config.netDropPct))} (${Math.round(ctx.config.netDropPct * 100)}% of prior ${dollars(p.netCents)})`,
          actual: `net ${dollars(d.netCents)}`,
          sourceOfExpected: "prior_run",
          description: "Net pay is below the threshold share of the prior period with no request.",
        });
      }
    }
    return out;
  },
};
