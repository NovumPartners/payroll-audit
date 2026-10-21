/**
 * B4: an earning type present this period and absent last period with no
 * one_time_pay request. A time-off payout is explained by a termination
 * request that asked for it.
 */
import type { Check, Exception } from "../types.js";
import { RECURRING_EARNING_TYPES, dollars } from "../context.js";
import { nameFor, profId, requestsFor } from "./_b.js";

export const B4: Check = {
  code: "B4",
  family: "B",
  title: "New earning type with no one-time pay request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      const priorTypes = new Set((p?.earnings ?? []).map((e) => e.type));
      const reqs = requestsFor(ctx, d.platformEmployeeId);
      const seen = new Set<string>();
      for (const e of d.earnings) {
        if (RECURRING_EARNING_TYPES.has(e.type) || priorTypes.has(e.type) || e.amountCents === 0 || seen.has(e.type)) continue;
        seen.add(e.type);
        const ok = reqs.some(
          (c) =>
            (c.payload.kind === "one_time_pay" && c.payload.earningType === e.type) ||
            (e.type === "pto_payout" && c.payload.kind === "termination" && c.payload.payoutAccruedTimeOff),
        );
        if (!ok) {
          const total = d.earnings.filter((x) => x.type === e.type).reduce((s, x) => s + x.amountCents, 0);
          out.push({
            checkCode: "B4",
            severity: "block",
            employeeId: profId(ctx, d),
            employeeName: nameFor(ctx, d),
            expected: `one_time_pay request for ${e.type}`,
            actual: `${e.type} ${dollars(total)} with no request`,
            sourceOfExpected: "ledger",
            description: `Earning type ${e.type} is new this period and has no request.`,
          });
        }
      }
    }
    return out;
  },
};
