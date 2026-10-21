/** B7: total client gross moved more than the threshold from the prior run. */
import type { Check } from "../types.js";
import { dollars } from "../context.js";

export const B7: Check = {
  code: "B7",
  family: "B",
  title: "Client total gross moved",
  severity: "review",
  run(ctx) {
    if (!ctx.prior) return [];
    const now = ctx.draft.employees.reduce((s, e) => s + e.grossCents, 0);
    const before = ctx.prior.employees.reduce((s, e) => s + e.grossCents, 0);
    if (before === 0) return [];
    const pct = Math.abs(now - before) / before;
    if (pct <= ctx.config.clientGrossMovePct) return [];
    return [
      {
        checkCode: "B7",
        severity: "review",
        expected: `total gross within ${Math.round(ctx.config.clientGrossMovePct * 100)}% of ${dollars(before)}`,
        actual: `total gross ${dollars(now)} (${(pct * 100).toFixed(1)}% move)`,
        sourceOfExpected: "prior_run",
        description: "Client total gross moved more than the threshold; confirm the drivers.",
      },
    ];
  },
};
