/**
 * A4: a terminated employee is paid through the termination date only, with
 * the requested time-off payout, and not at all in later periods. A later
 * rehire (profile active with a hire date after the termination) ends the
 * check for that termination.
 */
import type { Check, Exception } from "../types.js";
import { baseSalary, dollars, earning, expectedSalaryForPeriod } from "../context.js";

export const A4: Check = {
  code: "A4",
  family: "A",
  title: "Terminations stop pay on the termination date",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const period = ctx.draft.period;
    const { start, end } = period;
    for (const c of ctx.ledgerActive) {
      if (c.payload.kind !== "termination" || !c.employeeId || c.status === "received") continue;
      const prof = ctx.profileById.get(c.employeeId);
      if (!prof) continue;
      const term = c.payload.terminationDate;
      if (prof.status === "active" && prof.hireDate > term) continue; // rehired after this termination
      const d = ctx.draftByPlatformId.get(prof.platformEmployeeId);
      const name = prof.name;
      if (term < start && d && d.grossCents > 0) {
        out.push({
          checkCode: "A4",
          severity: "block",
          employeeId: prof.id,
          employeeName: name,
          expected: `no pay after termination ${term}`,
          actual: `gross ${dollars(d.grossCents)} in period ${start} to ${end}`,
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: `${name} was terminated ${term} but is still paid this period.`,
        });
        continue;
      }
      if (term >= start && term <= end && d) {
        if (d.periodEnd !== undefined && d.periodEnd > term) {
          out.push({
            checkCode: "A4",
            severity: "block",
            employeeId: prof.id,
            employeeName: name,
            expected: `final pay through ${term}`,
            actual: `paid through ${d.periodEnd}`,
            sourceOfExpected: "ledger",
            requestId: c.id,
            description: `Final pay for ${name} runs past the termination date.`,
          });
        } else if (d.payType === "salary" && term < end) {
          const from = prof.hireDate > start ? prof.hireDate : undefined;
          const expected = expectedSalaryForPeriod(d.rateCents, ctx.draft.payFrequency, period, ctx.config, from, term);
          const actual = baseSalary(d);
          if (actual > expected + ctx.config.prorationToleranceCents) {
            out.push({
              checkCode: "A4",
              severity: "block",
              employeeId: prof.id,
              employeeName: name,
              expected: `final regular at or under ${dollars(expected)} (through ${term}, ${ctx.config.prorationMethod.replace("_", " ")})`,
              actual: `regular ${dollars(actual)}`,
              sourceOfExpected: "ledger",
              requestId: c.id,
              description: `Final salary for ${name} exceeds the amount prorated through the termination date.`,
            });
          }
        }
        if (c.payload.payoutAccruedTimeOff && earning(d, "pto_payout") === 0) {
          out.push({
            checkCode: "A4",
            severity: "block",
            employeeId: prof.id,
            employeeName: name,
            expected: "accrued time-off payout on final check",
            actual: "no pto_payout earning line",
            sourceOfExpected: "ledger",
            requestId: c.id,
            description: `Request ${c.id} asks for accrued time-off payout; the final check has none.`,
          });
        }
      }
    }
    return out;
  },
};
