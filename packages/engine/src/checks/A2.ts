/**
 * A2: a salaried rate change effective inside the period is prorated correctly.
 * The old rate comes from the request (`previousRateCents`, captured when the
 * request was applied) or, when the profile still carries the old rate, from
 * the profile. When neither gives it and the change is mid-period, the check
 * reports the proration as not verifiable instead of guessing.
 */
import type { Check, Exception } from "../types.js";
import { baseSalary, dollars, expectedSalaryWithRateChange } from "../context.js";

export const A2: Check = {
  code: "A2",
  family: "A",
  title: "Rate changes applied with correct proration",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const period = ctx.draft.period;
    for (const c of ctx.ledgerInPeriod) {
      if (c.payload.kind !== "rate_change" || !c.employeeId) continue;
      if (c.status === "received") continue; // A5 covers unapplied requests
      const prof = ctx.profileById.get(c.employeeId);
      if (!prof || prof.payType !== "salary") continue;
      const d = ctx.draftByPlatformId.get(prof.platformEmployeeId);
      if (!d) continue; // A1 reports the missing employee
      const newRate = c.payload.newRateCents;
      const oldRate = c.payload.previousRateCents ?? (prof.rateCents !== newRate ? prof.rateCents : undefined);
      const from = prof.hireDate > period.start ? prof.hireDate : undefined;
      const to = prof.terminationDate && prof.terminationDate < period.end ? prof.terminationDate : undefined;
      const actual = baseSalary(d);
      if (oldRate === undefined && c.effectiveDate > period.start) {
        out.push({
          checkCode: "A2",
          severity: "review",
          employeeId: prof.id,
          employeeName: prof.name,
          expected: `prorated regular for rate change to ${dollars(newRate)} effective ${c.effectiveDate}`,
          actual: `regular ${dollars(actual)}; prior rate not recorded on request ${c.id}, proration not verifiable`,
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: "The request does not carry the previous rate and the profile already holds the new one; confirm the prorated amount by hand.",
        });
        continue;
      }
      const expected = expectedSalaryWithRateChange(oldRate ?? newRate, newRate, c.effectiveDate, ctx.draft.payFrequency, period, ctx.config, from, to);
      if (Math.abs(actual - expected) > ctx.config.prorationToleranceCents) {
        out.push({
          checkCode: "A2",
          severity: "block",
          employeeId: prof.id,
          employeeName: prof.name,
          expected: `regular ${dollars(expected)} (rate change effective ${c.effectiveDate}, ${ctx.config.prorationMethod.replace("_", " ")})`,
          actual: `regular ${dollars(actual)}`,
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: `Prorated regular pay for the rate change in request ${c.id} does not match the draft.`,
        });
      }
    }
    return out;
  },
};
