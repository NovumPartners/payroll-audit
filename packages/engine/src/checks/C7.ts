/**
 * C7: pay frequency, period length, and pay date on the draft fit the
 * client's pay schedule. A schedule_change request effective this period
 * moves the frequency expectation.
 */
import type { Check, Exception, PayFrequency } from "../types.js";
import { addDays, calendarDays, daysBetween } from "../context.js";

const PERIOD_DAYS: Record<PayFrequency, [number, number]> = { weekly: [7, 7], biweekly: [14, 14], semimonthly: [13, 16], monthly: [28, 31] };

export const C7: Check = {
  code: "C7",
  family: "C",
  title: "Pay schedule and period dates match the profile",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const sched = ctx.ledgerInPeriod.find((c) => c.payload.kind === "schedule_change");
    const expectedFreq = sched && sched.payload.kind === "schedule_change" ? sched.payload.payFrequency : ctx.profile.payFrequency;
    if (ctx.draft.payFrequency !== expectedFreq) {
      out.push({
        checkCode: "C7",
        severity: "block",
        expected: `pay frequency ${expectedFreq}`,
        actual: `pay frequency ${ctx.draft.payFrequency}`,
        sourceOfExpected: sched ? "ledger" : "profile",
        requestId: sched?.id,
        description: "Draft pay frequency does not match the profile.",
      });
    }
    const { start, end, payDate } = ctx.draft.period;
    const days = calendarDays(start, end);
    const range = PERIOD_DAYS[expectedFreq];
    if (days < range[0] || days > range[1]) {
      out.push({
        checkCode: "C7",
        severity: "block",
        expected: `period length ${range[0]}${range[0] === range[1] ? "" : ` to ${range[1]}`} days for ${expectedFreq}`,
        actual: `${days} days (${start} to ${end})`,
        sourceOfExpected: "profile",
        description: "Draft period length does not fit the pay frequency.",
      });
    }
    if (payDate < end) {
      out.push({
        checkCode: "C7",
        severity: "block",
        expected: `pay date on or after period end ${end}`,
        actual: `pay date ${payDate}`,
        sourceOfExpected: "platform_rule",
        description: "Pay date precedes the period end.",
      });
    } else if (ctx.profile.expectedPayDateLagDays !== undefined) {
      const expected = addDays(end, ctx.profile.expectedPayDateLagDays);
      const lag = daysBetween(end, payDate);
      const early = ctx.profile.expectedPayDateLagDays - lag;
      if (lag > ctx.profile.expectedPayDateLagDays || early > ctx.config.payDateEarlyToleranceDays) {
        out.push({
          checkCode: "C7",
          severity: "block",
          expected: `pay date ${expected} (${ctx.profile.expectedPayDateLagDays} days after period end, up to ${ctx.config.payDateEarlyToleranceDays} days earlier for a weekend or holiday)`,
          actual: `pay date ${payDate}`,
          sourceOfExpected: "profile",
          description: "Draft pay date does not follow the client's pay schedule.",
        });
      }
    }
    return out;
  },
};
