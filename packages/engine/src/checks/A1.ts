/** A1: every applied change request effective this period is reflected in the draft. */
import type { Check, Exception } from "../types.js";
import { dollars, earning, platformIdFor } from "../context.js";

export const A1: Check = {
  code: "A1",
  family: "A",
  title: "Applied change requests appear in the draft",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const c of ctx.ledgerInPeriod) {
      if (c.status !== "applied_to_profile" && c.status !== "verified_in_platform") continue;
      const p = c.payload;
      // time-off policy changes are not per employee
      if (p.kind === "time_off_change") {
        const accruals = ctx.draft.platformAccruals;
        if (!accruals) continue; // platform does not report policies; C6 states that
        const plat = accruals[p.policyName];
        const ok = !!plat && plat.rateHours === p.accrualRateHours && (p.capHours === undefined ? true : plat.capHours === p.capHours);
        if (!ok) {
          out.push({
            checkCode: "A1",
            severity: "block",
            expected: `${p.policyName}: ${p.accrualRateHours}h${p.capHours !== undefined ? `, cap ${p.capHours}h` : ""}`,
            actual: plat ? `${p.policyName}: ${plat.rateHours}h${plat.capHours !== undefined ? `, cap ${plat.capHours}h` : ", no cap"}` : `${p.policyName} not on platform`,
            sourceOfExpected: "ledger",
            requestId: c.id,
            description: `Change request ${c.id} (time_off_change, effective ${c.effectiveDate}) is not reflected on the platform policy.`,
          });
        }
        continue;
      }
      if (!c.employeeId) continue;
      const pid = platformIdFor(ctx, c.employeeId);
      const d = pid ? ctx.draftByPlatformId.get(pid) : undefined;
      const prof = ctx.profileById.get(c.employeeId);
      const name = prof?.name ?? c.employeeId;
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
          continue; // A4 owns terminations, including final pay and payout
        case "housing_change":
          present = !!d && earning(d, "housing_allowance") === p.perPeriodAmountCents;
          expected = `housing ${dollars(p.perPeriodAmountCents)} per period`;
          actual = d ? `housing ${dollars(earning(d, "housing_allowance"))}` : "employee not in draft";
          break;
        case "benefit_change": {
          const line = d?.deductions.find((x) => x.planId === p.planId);
          present = !!line && line.employeeCents === p.employeeDeductionCents && line.employerCents === p.employerContributionCents;
          expected = `${p.planId} employee ${dollars(p.employeeDeductionCents)} / employer ${dollars(p.employerContributionCents)}`;
          actual = line ? `${p.planId} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}` : d ? "plan not on draft" : "employee not in draft";
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
          actual = line ? `${p.deductionName} ${dollars(line.employeeCents)}` : d ? "deduction not on draft" : "employee not in draft";
          break;
        }
        case "schedule_change":
          continue; // C7 compares the draft frequency against the requested schedule
      }
      if (!present) {
        out.push({
          checkCode: "A1",
          severity: "block",
          employeeId: c.employeeId,
          employeeName: name,
          expected,
          actual,
          sourceOfExpected: "ledger",
          requestId: c.id,
          description: `Change request ${c.id} (${c.type}, effective ${c.effectiveDate}) is not reflected in the draft.`,
        });
      }
    }
    return out;
  },
};
