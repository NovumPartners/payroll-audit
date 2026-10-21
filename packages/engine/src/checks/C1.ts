/**
 * C1: rate, pay type, standard hours, and (for salary) the base salary for
 * the period match the signed profile. Base salary is the sum of regular,
 * pto, holiday and sick lines, prorated for a hire or termination inside the
 * period. A rate change pending this period moves the rate expectation and
 * hands the amount to A2.
 */
import type { Check, Exception } from "../types.js";
import { baseSalary, dollars, expectedSalaryForPeriod } from "../context.js";

export const C1: Check = {
  code: "C1",
  family: "C",
  title: "Rate, pay type, and standard hours match the profile",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const period = ctx.draft.period;
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue; // B2 covers missing employees
      const pending = ctx.ledgerInPeriod.find((c) => c.employeeId === p.id && c.payload.kind === "rate_change");
      const expectedRate = pending && pending.payload.kind === "rate_change" ? pending.payload.newRateCents : p.rateCents;
      const problems: string[] = [];
      if (d.payType !== p.payType) problems.push(`pay type ${d.payType} (profile ${p.payType})`);
      if (d.rateCents !== expectedRate) problems.push(`rate ${dollars(d.rateCents)} (profile ${dollars(expectedRate)})`);
      if (p.payType === "hourly" && d.standardHours !== undefined && d.standardHours !== p.standardHours) {
        problems.push(`standard hours ${d.standardHours} (profile ${p.standardHours})`);
      }
      if (p.payType === "salary" && d.payType === "salary" && !pending) {
        const termReq = ctx.ledgerInPeriod.find((c) => c.employeeId === p.id && c.payload.kind === "termination");
        const termDate = termReq && termReq.payload.kind === "termination" ? termReq.payload.terminationDate : p.terminationDate;
        const from = d.periodStart ?? (p.hireDate > period.start ? p.hireDate : undefined);
        const to = d.periodEnd ?? (termDate && termDate < period.end ? termDate : undefined);
        const exp = expectedSalaryForPeriod(p.rateCents, ctx.draft.payFrequency, period, ctx.config, from, to);
        const act = baseSalary(d);
        if (Math.abs(exp - act) > ctx.config.prorationToleranceCents) {
          problems.push(`base salary ${dollars(act)} (expected ${dollars(exp)}${from || to ? ", prorated" : ""})`);
        }
      }
      if (problems.length) {
        out.push({
          checkCode: "C1",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `${p.payType} at ${dollars(expectedRate)}${p.payType === "hourly" ? `, ${p.standardHours} standard hours` : ""}`,
          actual: problems.join("; "),
          sourceOfExpected: "profile",
          description: "Platform compensation does not match the signed profile.",
        });
      }
    }
    return out;
  },
};
