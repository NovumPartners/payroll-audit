/** Family B: Platform to prior period. Every movement has a reason. */
import type { Check, CheckContext, ChangeRequest, DraftEmployee, Exception } from "../types.js";
import { dollars } from "../context.js";

/** Ledger requests (any status except rejected) for an employee, by platform id, effective in or before this period. */
function requestsFor(ctx: CheckContext, platformId: string): ChangeRequest[] {
  const prof = ctx.profileByPlatformId.get(platformId);
  if (!prof) return [];
  const { end } = ctx.draft.period;
  const priorEnd = ctx.prior?.period.end ?? "0000-00-00";
  return ctx.ledger.filter(
    (c) => c.employeeId === prof.id && c.status !== "rejected" && c.effectiveDate > priorEnd && c.effectiveDate <= end,
  );
}

function nameFor(ctx: CheckContext, d: DraftEmployee): string {
  return ctx.profileByPlatformId.get(d.platformEmployeeId)?.name ?? d.name;
}

function profId(ctx: CheckContext, d: DraftEmployee): string | undefined {
  return ctx.profileByPlatformId.get(d.platformEmployeeId)?.id;
}

export const B1: Check = {
  code: "B1",
  family: "B",
  title: "Gross moved with no change request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p) continue; // B2 handles adds
      const reqs = requestsFor(ctx, d.platformEmployeeId);
      if (reqs.length) continue;
      if (d.payType === "hourly") {
        if (d.rateCents !== p.rateCents) {
          out.push({
            checkCode: "B1",
            severity: "block",
            employeeId: profId(ctx, d),
            employeeName: nameFor(ctx, d),
            expected: `hourly rate ${dollars(p.rateCents)} (prior period)`,
            actual: `hourly rate ${dollars(d.rateCents)}`,
            sourceOfExpected: "prior_run",
            description: "Hourly rate changed with no rate_change request on the ledger.",
          });
        }
        continue; // hours variance is B3
      }
      const delta = Math.abs(d.grossCents - p.grossCents);
      const threshold = Math.max(ctx.config.grossMoveMinCents, Math.round(p.grossCents * ctx.config.grossMovePct));
      if (delta > threshold) {
        out.push({
          checkCode: "B1",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: `gross within ${dollars(threshold)} of ${dollars(p.grossCents)}`,
          actual: `gross ${dollars(d.grossCents)}`,
          sourceOfExpected: "prior_run",
          description: "Gross pay moved with no change request on the ledger.",
        });
      }
    }
    return out;
  },
};

export const B2: Check = {
  code: "B2",
  family: "B",
  title: "Headcount changed with no hire or termination request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      if (ctx.priorByPlatformId.has(d.platformEmployeeId)) continue;
      const hire = requestsFor(ctx, d.platformEmployeeId).some((c) => c.type === "new_hire");
      if (!hire) {
        out.push({
          checkCode: "B2",
          severity: "block",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: "new_hire request on the ledger",
          actual: "employee appears in draft, absent from prior run, no request",
          sourceOfExpected: "prior_run",
          description: "Employee added to payroll with no new_hire request.",
        });
      }
    }
    for (const p of ctx.prior.employees) {
      if (ctx.draftByPlatformId.has(p.platformEmployeeId)) continue;
      const prof = ctx.profileByPlatformId.get(p.platformEmployeeId);
      const term = ctx.ledger.some(
        (c) => c.employeeId === prof?.id && c.type === "termination" && c.status !== "rejected",
      );
      if (!term) {
        out.push({
          checkCode: "B2",
          severity: "block",
          employeeId: prof?.id,
          employeeName: prof?.name ?? p.name,
          expected: "termination request on the ledger",
          actual: "employee in prior run, absent from draft, no request",
          sourceOfExpected: "prior_run",
          description: "Employee dropped from payroll with no termination request.",
        });
      }
    }
    return out;
  },
};

export const B3: Check = {
  code: "B3",
  family: "B",
  title: "Hourly hours unusually high",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    for (const d of ctx.draft.employees) {
      if (d.payType !== "hourly") continue;
      const prof = ctx.profileByPlatformId.get(d.platformEmployeeId);
      const standard = prof?.standardHours ?? 40;
      const limit = Math.min(standard * ctx.config.hoursMultiplier, ctx.config.hoursHardCap);
      if (d.hours > limit) {
        out.push({
          checkCode: "B3",
          severity: "review",
          employeeId: prof?.id,
          employeeName: nameFor(ctx, d),
          expected: `hours at or under ${limit}`,
          actual: `${d.hours} hours`,
          sourceOfExpected: "profile",
          description: "Hours exceed 1.5x standard or the hard cap; confirm the timesheet.",
        });
      }
    }
    return out;
  },
};

export const B4: Check = {
  code: "B4",
  family: "B",
  title: "New earning type with no one-time pay request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    const routine = new Set(["regular", "overtime", "housing_allowance", "pto", "holiday", "sick"]);
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      const priorTypes = new Set((p?.earnings ?? []).map((e) => e.type));
      for (const e of d.earnings) {
        if (routine.has(e.type) || priorTypes.has(e.type) || e.amountCents === 0) continue;
        const ok = requestsFor(ctx, d.platformEmployeeId).some(
          (c) => c.payload.kind === "one_time_pay" && c.payload.earningType === e.type,
        );
        if (!ok) {
          out.push({
            checkCode: "B4",
            severity: "block",
            employeeId: profId(ctx, d),
            employeeName: nameFor(ctx, d),
            expected: `one_time_pay request for ${e.type}`,
            actual: `${e.type} ${dollars(e.amountCents)} with no request`,
            sourceOfExpected: "ledger",
            description: `Earning type ${e.type} is new this period and has no request.`,
          });
        }
      }
    }
    return out;
  },
};

export const B5: Check = {
  code: "B5",
  family: "B",
  title: "Deduction or contribution changed with no benefit request",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p) continue;
      const reqs = requestsFor(ctx, d.platformEmployeeId).filter(
        (c) => c.type === "benefit_change" || c.type === "deduction_change",
      );
      for (const line of d.deductions) {
        const prior = p.deductions.find((x) => (x.planId && x.planId === line.planId) || x.name === line.name);
        const changed = !prior || prior.employeeCents !== line.employeeCents || prior.employerCents !== line.employerCents;
        if (!changed) continue;
        const explained = reqs.some(
          (c) =>
            (c.payload.kind === "benefit_change" && c.payload.planId === line.planId) ||
            (c.payload.kind === "deduction_change" && c.payload.deductionName === line.name),
        );
        if (!explained) {
          out.push({
            checkCode: "B5",
            severity: "block",
            employeeId: profId(ctx, d),
            employeeName: nameFor(ctx, d),
            expected: prior
              ? `${line.name} employee ${dollars(prior.employeeCents)} / employer ${dollars(prior.employerCents)}`
              : `no ${line.name} deduction (prior period)`,
            actual: `${line.name} employee ${dollars(line.employeeCents)} / employer ${dollars(line.employerCents)}`,
            sourceOfExpected: "prior_run",
            description: "Deduction or employer contribution changed with no request.",
          });
        }
      }
    }
    return out;
  },
};

export const B6: Check = {
  code: "B6",
  family: "B",
  title: "Net pay dropped sharply",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    if (!ctx.prior) return out;
    for (const d of ctx.draft.employees) {
      const p = ctx.priorByPlatformId.get(d.platformEmployeeId);
      if (!p || p.netCents <= 0) continue;
      if (d.netCents < p.netCents * ctx.config.netDropPct && requestsFor(ctx, d.platformEmployeeId).length === 0) {
        out.push({
          checkCode: "B6",
          severity: "review",
          employeeId: profId(ctx, d),
          employeeName: nameFor(ctx, d),
          expected: `net near ${dollars(p.netCents)}`,
          actual: `net ${dollars(d.netCents)}`,
          sourceOfExpected: "prior_run",
          description: "Net pay is below half of the prior period with no request.",
        });
      }
    }
    return out;
  },
};

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

export const familyB: Check[] = [B1, B2, B3, B4, B5, B6, B7];
