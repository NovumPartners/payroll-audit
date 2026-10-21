/** Family A: Ledger to platform. Every change in the ledger shows up in the draft. */
import type { Check, CheckContext, Exception } from "../types.js";
import { dollars, earning, platformIdFor } from "../context.js";

function ex(partial: Omit<Exception, "severity"> & { severity?: Exception["severity"] }, severity: Exception["severity"]): Exception {
  return { severity, ...partial };
}

export const A1: Check = {
  code: "A1",
  family: "A",
  title: "Applied change requests appear in the draft",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const c of ctx.ledgerInPeriod) {
      if (c.status !== "applied_to_profile" && c.status !== "verified_in_platform") continue;
      if (!c.employeeId) continue;
      const pid = platformIdFor(ctx, c.employeeId);
      const d = pid ? ctx.draftByPlatformId.get(pid) : undefined;
      const prof = ctx.profile.employees.find((e) => e.id === c.employeeId);
      const name = prof?.name ?? c.employeeId;
      const p = c.payload;
      let present = true;
      let expected = "";
      let actual = "";
      switch (p.kind) {
        case "rate_change":
          present = !!d && d.rateCents === p.newRateCents;
          expected = `rate ${dollars(p.newRateCents)}`;
          actual = d ? `rate ${dollars(d.rateCents)}` : "employee not in draft";
          break;
        case "new_hire":
          present = !!d;
          expected = `employee in draft from ${p.hireDate}`;
          actual = d ? "present" : "employee not in draft";
          break;
        case "termination":
          present = !d || (d.periodEnd ?? ctx.draft.period.end) <= p.terminationDate || d.grossCents >= 0;
          expected = `final pay through ${p.terminationDate}`;
          actual = d ? `in draft, gross ${dollars(d.grossCents)}` : "not in draft";
          break;
        case "housing_change":
          present = !!d && earning(d, "housing_allowance") === p.perPeriodAmountCents;
          expected = `housing ${dollars(p.perPeriodAmountCents)} per period`;
          actual = d ? `housing ${dollars(earning(d, "housing_allowance"))}` : "employee not in draft";
          break;
        case "benefit_change": {
          const line = d?.deductions.find((x) => x.planId === p.planId);
          present = !!line && line.employeeCents === p.employeeDeductionCents && line.employerCents === p.employerContributionCents;
          expected = `${p.planId} employee ${dollars(p.employeeDeductionCents)} / employer ${dollars(p.employerContributionCents)}`;
          actual = line ? `${p.planId} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}` : "plan not on draft";
          break;
        }
        case "one_time_pay":
          present = !!d && earning(d, p.earningType) === p.amountCents;
          expected = `${p.earningType} ${dollars(p.amountCents)}`;
          actual = d ? `${p.earningType} ${dollars(earning(d, p.earningType))}` : "employee not in draft";
          break;
        case "deduction_change": {
          const line = d?.deductions.find((x) => x.name === p.deductionName);
          present = !!line && line.employeeCents === p.amountCents;
          expected = `${p.deductionName} ${dollars(p.amountCents)}`;
          actual = line ? `${p.deductionName} ${dollars(line.employeeCents)}` : "deduction not on draft";
          break;
        }
        default:
          continue; // time_off_change and schedule_change are covered by C6 and C7
      }
      if (!present) {
        out.push(
          ex(
            {
              checkCode: "A1",
              employeeId: c.employeeId,
              employeeName: name,
              expected,
              actual,
              sourceOfExpected: "ledger",
              description: `Change request ${c.id} (${c.type}, effective ${c.effectiveDate}) is not reflected in the draft.`,
            },
            "block",
          ),
        );
      }
    }
    return out;
  },
};

export const A2: Check = {
  code: "A2",
  family: "A",
  title: "Rate changes applied with correct proration",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const { start, end } = ctx.draft.period;
    const periodDays = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
    for (const c of ctx.ledgerInPeriod) {
      if (c.payload.kind !== "rate_change" || !c.employeeId) continue;
      if (c.status === "received") continue; // A5 covers unapplied requests
      const prof = ctx.profile.employees.find((e) => e.id === c.employeeId);
      if (!prof || prof.payType !== "salary") continue;
      const d = ctx.draftByPlatformId.get(prof.platformEmployeeId);
      if (!d) continue;
      const periods = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }[ctx.draft.payFrequency];
      const oldPer = Math.round(prof.rateCents / periods);
      const newPer = Math.round(c.payload.newRateCents / periods);
      const daysAtOld = Math.max(0, Math.round((Date.parse(c.effectiveDate) - Date.parse(start)) / 864e5));
      const daysAtNew = periodDays - daysAtOld;
      const expected = c.effectiveDate <= start ? newPer : Math.round((oldPer * daysAtOld + newPer * daysAtNew) / periodDays);
      const actual = earning(d, "regular");
      if (Math.abs(actual - expected) > 100) {
        out.push({
          checkCode: "A2",
          severity: "block",
          employeeId: prof.id,
          employeeName: prof.name,
          expected: `regular ${dollars(expected)} (rate change effective ${c.effectiveDate})`,
          actual: `regular ${dollars(actual)}`,
          sourceOfExpected: "ledger",
          description: `Prorated regular pay for the rate change in request ${c.id} does not match the draft.`,
        });
      }
    }
    return out;
  },
};

export const A3: Check = {
  code: "A3",
  family: "A",
  title: "New hires start on the hire date with the requested pay",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const c of ctx.ledgerInPeriod) {
      if (c.payload.kind !== "new_hire" || !c.employeeId || c.status === "received") continue;
      const prof = ctx.profile.employees.find((e) => e.id === c.employeeId);
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
          description: `New hire ${name} (request ${c.id}) is missing from the draft.`,
        });
        continue;
      }
      const problems: string[] = [];
      if (d.payType !== c.payload.payType) problems.push(`pay type ${d.payType}`);
      if (d.rateCents !== c.payload.rateCents) problems.push(`rate ${dollars(d.rateCents)}`);
      const pStart = d.periodStart ?? ctx.draft.period.start;
      if (pStart < c.payload.hireDate) problems.push(`paid from ${pStart}`);
      if (problems.length) {
        out.push({
          checkCode: "A3",
          severity: "block",
          employeeId: c.employeeId,
          employeeName: name,
          expected: `${c.payload.payType} at ${dollars(c.payload.rateCents)}, paid from ${c.payload.hireDate}`,
          actual: problems.join(", "),
          sourceOfExpected: "ledger",
          description: `New hire ${name} is set up differently from request ${c.id}.`,
        });
      }
    }
    return out;
  },
};

export const A4: Check = {
  code: "A4",
  family: "A",
  title: "Terminations stop pay on the termination date",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const { start, end } = ctx.draft.period;
    for (const c of ctx.ledger) {
      if (c.payload.kind !== "termination" || !c.employeeId || c.status === "received" || c.status === "rejected") continue;
      const prof = ctx.profile.employees.find((e) => e.id === c.employeeId);
      if (!prof) continue;
      const d = ctx.draftByPlatformId.get(prof.platformEmployeeId);
      const term = c.payload.terminationDate;
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
          description: `${name} was terminated ${term} but is still paid this period.`,
        });
        continue;
      }
      if (term >= start && term <= end && d) {
        const pEnd = d.periodEnd ?? end;
        if (pEnd > term) {
          out.push({
            checkCode: "A4",
            severity: "block",
            employeeId: prof.id,
            employeeName: name,
            expected: `final pay through ${term}`,
            actual: `paid through ${pEnd}`,
            sourceOfExpected: "ledger",
            description: `Final pay for ${name} runs past the termination date.`,
          });
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
            description: `Request ${c.id} asks for accrued time-off payout; the final check has none.`,
          });
        }
      }
    }
    return out;
  },
};

export const A5: Check = {
  code: "A5",
  family: "A",
  title: "Received requests effective this period are not yet applied",
  severity: "block",
  run(ctx) {
    return ctx.ledgerInPeriod
      .filter((c) => c.status === "received")
      .map((c) => {
        const prof = c.employeeId ? ctx.profile.employees.find((e) => e.id === c.employeeId) : undefined;
        return {
          checkCode: "A5",
          severity: "block" as const,
          employeeId: c.employeeId,
          employeeName: prof?.name,
          expected: "request applied to profile before the run",
          actual: `status received (submitted ${c.submittedAt} by ${c.submittedBy})`,
          sourceOfExpected: "ledger" as const,
          description: `Request ${c.id} (${c.type}, effective ${c.effectiveDate}) has not been applied.`,
        };
      });
  },
};

export const familyA: Check[] = [A1, A2, A3, A4, A5];
