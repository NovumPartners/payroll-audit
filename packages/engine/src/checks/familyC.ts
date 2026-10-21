/** Family C: Platform to Payroll Profile. Setup matches what was signed. */
import type { Check, Exception } from "../types.js";
import { dollars, earning, expectedRegularCents } from "../context.js";

export const C1: Check = {
  code: "C1",
  family: "C",
  title: "Rate, pay type, and standard hours match the profile",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue; // B2 covers missing employees
      // a rate_change request in this period that is applied moves the expectation; A1/A2 verify it
      const pending = ctx.ledgerInPeriod.find((c) => c.employeeId === p.id && c.payload.kind === "rate_change");
      const expectedRate = pending && pending.payload.kind === "rate_change" ? pending.payload.newRateCents : p.rateCents;
      const problems: string[] = [];
      if (d.payType !== p.payType) problems.push(`pay type ${d.payType} (profile ${p.payType})`);
      if (d.rateCents !== expectedRate) problems.push(`rate ${dollars(d.rateCents)} (profile ${dollars(expectedRate)})`);
      if (p.payType === "salary" && !pending) {
        const exp = expectedRegularCents(p, ctx.draft.payFrequency, 0);
        const act = earning(d, "regular");
        if (Math.abs(exp - act) > 100 && d.periodStart === undefined && d.periodEnd === undefined) {
          problems.push(`regular ${dollars(act)} (expected ${dollars(exp)})`);
        }
      }
      if (problems.length) {
        out.push({
          checkCode: "C1",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `${p.payType} at ${dollars(expectedRate)}`,
          actual: problems.join("; "),
          sourceOfExpected: "profile",
          description: "Platform compensation does not match the signed profile.",
        });
      }
    }
    return out;
  },
};

export const C2: Check = {
  code: "C2",
  family: "C",
  title: "Housing allowance matches the designation",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const h = ctx.housingByEmployee.get(p.id);
      const housingLine = earning(d, "housing_allowance");
      const pendingHousing = ctx.ledgerInPeriod.find((c) => c.employeeId === p.id && c.payload.kind === "housing_change");
      if (pendingHousing) continue; // A1 verifies the change itself
      if (!p.isMinister && housingLine > 0) {
        out.push({
          checkCode: "C2",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "no housing allowance (not a minister on the profile)",
          actual: `housing ${dollars(housingLine)}`,
          sourceOfExpected: "profile",
          description: "Housing allowance paid to an employee the profile does not designate as a minister.",
        });
        continue;
      }
      if (p.isMinister && !h && housingLine > 0) {
        out.push({
          checkCode: "C2",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "a board housing designation on the profile",
          actual: `housing ${dollars(housingLine)} with no designation`,
          sourceOfExpected: "profile",
          description: "Minister is paid a housing allowance but no resolution is on file.",
        });
        continue;
      }
      if (p.isMinister && h) {
        if (housingLine !== h.perPeriodAmountCents) {
          out.push({
            checkCode: "C2",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `housing ${dollars(h.perPeriodAmountCents)} per period (resolution ${h.resolutionDate})`,
            actual: `housing ${dollars(housingLine)}`,
            sourceOfExpected: "profile",
            description: "Housing allowance per period does not match the designation.",
          });
        }
        const ytd = (d.ytdHousingCents ?? 0) + housingLine;
        if (ytd > h.annualAmountCents) {
          out.push({
            checkCode: "C2",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `year-to-date housing at or under ${dollars(h.annualAmountCents)}`,
            actual: `year-to-date housing ${dollars(ytd)} after this run`,
            sourceOfExpected: "profile",
            description: "This run would exceed the annual designated housing amount.",
          });
        }
      }
    }
    return out;
  },
};

export const C3: Check = {
  code: "C3",
  family: "C",
  title: "Minister FICA exemption and voluntary withholding",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      if (!p.isMinister) continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const t = d.taxes;
      if (p.ficaExempt) {
        const fica = t.socialSecurityEmployeeCents + t.medicareEmployeeCents + t.socialSecurityEmployerCents + t.medicareEmployerCents;
        if (fica !== 0) {
          out.push({
            checkCode: "C3",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: "zero Social Security and Medicare (minister, FICA exempt)",
            actual: `FICA withheld or contributed ${dollars(fica)}`,
            sourceOfExpected: "profile",
            description: "Platform is withholding FICA from a minister the profile marks exempt.",
          });
        }
      }
      if (!p.fedWithholdingVoluntary && t.federalWithholdingCents !== 0) {
        out.push({
          checkCode: "C3",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "no federal withholding (no voluntary election on the profile)",
          actual: `federal withholding ${dollars(t.federalWithholdingCents)}`,
          sourceOfExpected: "profile",
          description: "Federal withholding present for a minister with no voluntary withholding election.",
        });
      }
    }
    return out;
  },
};

export const C4: Check = {
  code: "C4",
  family: "C",
  title: "Housing allowance earning type excluded from taxable wages",
  severity: "block",
  run(ctx) {
    const anyHousing = ctx.draft.employees.some((e) => earning(e, "housing_allowance") > 0);
    if (!anyHousing) return [];
    const out: Exception[] = [];
    if (ctx.draft.platformHousingEarningExcluded === false) {
      out.push({
        checkCode: "C4",
        severity: "block",
        expected: "housing_allowance earning type excluded from taxable wages",
        actual: "earning type configured as taxable",
        sourceOfExpected: "platform_rule",
        description: "Platform earning type for housing allowance is not set to exclude from income.",
      });
    }
    for (const e of ctx.draft.employees) {
      for (const line of e.earnings) {
        if (line.type === "housing_allowance" && line.amountCents > 0 && line.excludedFromTaxableWages === false) {
          const p = ctx.profileByPlatformId.get(e.platformEmployeeId);
          out.push({
            checkCode: "C4",
            severity: "block",
            employeeId: p?.id,
            employeeName: p?.name ?? e.name,
            expected: "housing line excluded from taxable wages",
            actual: `housing ${dollars(line.amountCents)} taxable`,
            sourceOfExpected: "platform_rule",
            description: "Housing allowance line is flagged taxable on the draft.",
          });
        }
      }
    }
    return out;
  },
};

export const C5: Check = {
  code: "C5",
  family: "C",
  title: "Benefit deductions and contributions match elections",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const elections = ctx.electionsByEmployee.get(p.id) ?? [];
      const pendingPlans = new Set(
        ctx.ledgerInPeriod
          .filter((c) => c.employeeId === p.id && c.payload.kind === "benefit_change")
          .map((c) => (c.payload.kind === "benefit_change" ? c.payload.planId : "")),
      );
      for (const el of elections) {
        if (pendingPlans.has(el.planId)) continue;
        const line = d.deductions.find((x) => x.planId === el.planId);
        if (!line) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `${el.planName} employee ${dollars(el.employeeDeductionCents)} / employer ${dollars(el.employerContributionCents)}`,
            actual: "plan missing from draft",
            sourceOfExpected: "profile",
            description: "An elected benefit is not on the draft.",
          });
          continue;
        }
        const problems: string[] = [];
        if (line.employeeCents !== el.employeeDeductionCents) problems.push(`employee ${dollars(line.employeeCents)}`);
        if (line.employerCents !== el.employerContributionCents) problems.push(`employer ${dollars(line.employerCents)}`);
        if (line.preTax !== el.preTax) problems.push(`${line.preTax ? "pre-tax" : "post-tax"}`);
        if (problems.length) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `${el.planName} employee ${dollars(el.employeeDeductionCents)} / employer ${dollars(el.employerContributionCents)}, ${el.preTax ? "pre-tax" : "post-tax"}`,
            actual: `${el.planName} ${problems.join(", ")}`,
            sourceOfExpected: "profile",
            description: "Benefit amounts or tax treatment differ from the election on the profile.",
          });
        }
      }
      for (const line of d.deductions) {
        if (line.planId && !elections.some((el) => el.planId === line.planId) && !pendingPlans.has(line.planId)) {
          out.push({
            checkCode: "C5",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `no ${line.name} deduction (no election on profile)`,
            actual: `${line.name} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}`,
            sourceOfExpected: "profile",
            description: "A deduction is running with no election on the profile.",
          });
        }
      }
    }
    return out;
  },
};

export const C6: Check = {
  code: "C6",
  family: "C",
  title: "Time-off accrual setup and balances",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    const accruals = ctx.draft.platformAccruals ?? {};
    for (const pol of ctx.profile.timeOffPolicies) {
      const plat = accruals[pol.policyName];
      if (plat && (plat.rateHours !== pol.accrualRateHours || (pol.capHours !== undefined && plat.capHours !== pol.capHours))) {
        out.push({
          checkCode: "C6",
          severity: "review",
          expected: `${pol.policyName}: ${pol.accrualRateHours}h ${pol.accrualBasis}${pol.capHours !== undefined ? `, cap ${pol.capHours}h` : ""}`,
          actual: `${pol.policyName}: ${plat.rateHours}h${plat.capHours !== undefined ? `, cap ${plat.capHours}h` : ", no cap"}`,
          sourceOfExpected: "profile",
          description: "Platform accrual policy differs from the profile.",
        });
      }
      if (!ctx.prior) continue;
      for (const empId of pol.assignedEmployeeIds) {
        const p = ctx.profile.employees.find((e) => e.id === empId);
        const d = p ? ctx.draftByPlatformId.get(p.platformEmployeeId) : undefined;
        const prior = p ? ctx.priorByPlatformId.get(p.platformEmployeeId) : undefined;
        if (!p || !d || !prior || d.timeOffBalanceHours === undefined || prior.timeOffBalanceHours === undefined) continue;
        const accrued =
          pol.accrualBasis === "per_period" ? pol.accrualRateHours : pol.accrualBasis === "per_hour" ? pol.accrualRateHours * d.hours : 0;
        const used = earning(d, "pto") > 0 && d.payType === "hourly" && d.rateCents > 0 ? earning(d, "pto") / d.rateCents : 0;
        let expected = prior.timeOffBalanceHours + accrued - used;
        if (pol.capHours !== undefined) expected = Math.min(expected, pol.capHours);
        if (Math.abs(d.timeOffBalanceHours - expected) > ctx.config.accrualToleranceHours) {
          out.push({
            checkCode: "C6",
            severity: "review",
            employeeId: p.id,
            employeeName: p.name,
            expected: `balance near ${expected.toFixed(1)}h`,
            actual: `balance ${d.timeOffBalanceHours.toFixed(1)}h`,
            sourceOfExpected: "profile",
            description: "Time-off balance is outside tolerance of the policy-computed balance.",
          });
        }
      }
    }
    return out;
  },
};

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
        sourceOfExpected: "profile",
        description: "Draft pay frequency does not match the profile.",
      });
    }
    const { start, end, payDate } = ctx.draft.period;
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
    const expectedDays: Record<string, [number, number]> = { weekly: [7, 7], biweekly: [14, 14], semimonthly: [13, 16], monthly: [28, 31] };
    const range = expectedDays[expectedFreq] ?? [1, 31];
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
    }
    return out;
  },
};

export const C8: Check = {
  code: "C8",
  family: "C",
  title: "Work state matches platform tax setup",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const setup = new Set(ctx.draft.stateTaxSetup ?? ctx.profile.registeredStates);
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      if (d.workState !== p.workState) {
        out.push({
          checkCode: "C8",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `work state ${p.workState}`,
          actual: `work state ${d.workState}`,
          sourceOfExpected: "profile",
          description: "Platform work state differs from the profile.",
        });
      }
      if (!setup.has(d.workState)) {
        out.push({
          checkCode: "C8",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `state tax registration for ${d.workState}`,
          actual: `no registration for ${d.workState}`,
          sourceOfExpected: "platform_rule",
          description: "Employee works in a state with no tax registration on the platform.",
        });
      }
    }
    return out;
  },
};

export const familyC: Check[] = [C1, C2, C3, C4, C5, C6, C7, C8];
