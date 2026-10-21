/**
 * A3: a new hire is in the draft with the requested pay type and rate, and is
 * not paid for days before the hire date. For a salaried hire the second
 * test is arithmetic: base salary may not exceed the prorated amount from the
 * hire date. For an hourly hire it relies on the platform's first paid day
 * when the adapter exposes one.
 */
import type { Check, Exception } from "../types";
import { baseSalary, dollars, expectedSalaryForPeriod } from "../context";

export const A3: Check = {
  code: "A3",
  family: "A",
  title: "New hires start on the hire date with the requested pay",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const period = ctx.draft.period;
    for (const c of ctx.ledgerInPeriod) {
      if (c.payload.kind !== "new_hire" || !c.employeeId || c.status === "received") continue;
      const prof = ctx.profileById.get(c.employeeId);
      const d = prof ? ctx.draftByPlatformId.get(prof.platformEmployeeId) : undefined;
      const name = prof?.name ?? c.employeeId;
      if (!d) {
        out.push({
          checkCode: "A3",
          severity: "block",
          employeeId: c.employeeId,
          employeeName: name,
          expected: `new hire in draft from ${c.payload.hireDate}`,
          actual: "not in draft",
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: `New hire ${name} (request ${c.id}) is missing from the draft.`,
        });
        continue;
      }
      const problems: string[] = [];
      if (d.payType !== c.payload.payType) problems.push(`pay type ${d.payType}`);
      if (d.rateCents !== c.payload.rateCents) problems.push(`rate ${dollars(d.rateCents)}`);
      if (d.periodStart !== undefined && d.periodStart < c.payload.hireDate) problems.push(`paid from ${d.periodStart}`);
      if (c.payload.payType === "salary" && d.payType === "salary" && c.payload.hireDate > period.start) {
        const expected = expectedSalaryForPeriod(c.payload.rateCents, ctx.draft.payFrequency, period, ctx.config, c.payload.hireDate);
        const actual = baseSalary(d);
        if (actual > expected + ctx.config.prorationToleranceCents) problems.push(`regular ${dollars(actual)} exceeds ${dollars(expected)} prorated from ${c.payload.hireDate}`);
      }
      if (problems.length) {
        out.push({
          checkCode: "A3",
          severity: "block",
          employeeId: c.employeeId,
          employeeName: name,
          expected: `${c.payload.payType} at ${dollars(c.payload.rateCents)}, paid from ${c.payload.hireDate}`,
          actual: problems.join(", "),
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: `New hire ${name} is set up differently from request ${c.id}.`,
        });
      }
    }
    return out;
  },
};
