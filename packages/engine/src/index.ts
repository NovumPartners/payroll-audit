import { buildContext, cmp, dollars } from "./context";
import { ALL_CHECKS } from "./checks/index";
import type { Check, CheckContext, Exception, Movement, RunInput, RunReport } from "./types";

export * from "./types";
export {
  buildContext,
  dollars,
  daysBetween,
  calendarDays,
  workDays,
  addDays,
  periodsPerYear,
  perPeriodSalary,
  expectedSalaryForPeriod,
  expectedSalaryWithRateChange,
  periodFraction,
  recurringGross,
  baseSalary,
  earning,
  earningHours,
  scaledHours,
  RECURRING_EARNING_TYPES,
  BASE_SALARY_TYPES,
} from "./context";
export { renderReportMarkdown, renderPreviewMarkdown } from "./report";
export { ALL_CHECKS, familyA, familyB, familyC, familyD } from "./checks/index";
export { anniversaryInPeriod } from "./checks/D2";

const severityRank = { block: 0, review: 1, info: 2 } as const;

export function sortExceptions(exceptions: Exception[]): Exception[] {
  return exceptions.slice().sort((a, b) => {
    const s = severityRank[a.severity] - severityRank[b.severity];
    if (s !== 0) return s;
    return (
      cmp(a.employeeName ?? "", b.employeeName ?? "") ||
      cmp(a.checkCode, b.checkCode) ||
      cmp(a.expected, b.expected) ||
      cmp(a.actual, b.actual)
    );
  });
}

/** Every employee whose gross moved against the prior run, with the reason the ledger gives. */
export function movements(ctx: CheckContext): Movement[] {
  const out: Movement[] = [];
  const ids = new Set<string>([...ctx.draftByPlatformId.keys(), ...ctx.priorByPlatformId.keys()]);
  const priorEnd = ctx.prior?.period.end ?? "0000-00-00";
  for (const pid of ids) {
    const d = ctx.draftByPlatformId.get(pid);
    const p = ctx.priorByPlatformId.get(pid);
    const prof = ctx.profileByPlatformId.get(pid);
    const name = prof?.name ?? d?.name ?? p?.name ?? pid;
    const reqs = ctx.ledgerActive.filter((c) => prof && c.employeeId === prof.id && c.effectiveDate > priorEnd && c.effectiveDate <= ctx.draft.period.end);
    const cite = reqs.map((c) => `${c.type} ${c.id}`).join(", ");
    if (d && !p) {
      if (!ctx.prior) continue; // nothing to move against
      out.push({ employeeId: prof?.id, employeeName: name, grossCents: d.grossCents, deltaCents: d.grossCents, reason: cite ? `new this period (${cite})` : "new this period, no request on the ledger" });
      continue;
    }
    if (p && !d) {
      const term = ctx.ledgerActive.find((c) => prof && c.employeeId === prof.id && c.type === "termination");
      const why = term ? `termination ${term.id}` : prof && prof.status !== "active" ? `profile status ${prof.status}` : "no request on the ledger";
      out.push({ employeeId: prof?.id, employeeName: name, priorGrossCents: p.grossCents, deltaCents: -p.grossCents, reason: `not in this run (${why})` });
      continue;
    }
    if (!d || !p) continue;
    const delta = d.grossCents - p.grossCents;
    if (delta === 0) continue;
    let reason = cite;
    if (!reason && d.payType === "hourly" && d.hours !== p.hours) reason = `hours ${p.hours} to ${d.hours} at ${dollars(d.rateCents)}`;
    if (!reason) reason = "no request on the ledger";
    out.push({ employeeId: prof?.id, employeeName: name, priorGrossCents: p.grossCents, grossCents: d.grossCents, deltaCents: delta, reason });
  }
  return out.sort((a, b) => cmp(a.employeeName, b.employeeName) || cmp(a.employeeId ?? "", b.employeeId ?? ""));
}

export function runChecks(input: RunInput, checks: Check[] = ALL_CHECKS): RunReport {
  const ctx = buildContext(input);
  const exceptions: Exception[] = [];
  for (const check of checks) {
    for (const e of check.run(ctx)) exceptions.push(e);
  }
  const sorted = sortExceptions(exceptions);
  const counts = { block: 0, review: 0, info: 0 };
  for (const e of sorted) counts[e.severity]++;
  const totalGrossCents = input.draft.employees.reduce((s, e) => s + e.grossCents, 0);
  const totalNetCents = input.draft.employees.reduce((s, e) => s + e.netCents, 0);
  return {
    clientId: input.profile.clientId,
    clientName: input.profile.clientName,
    platformPayrollId: input.draft.platformPayrollId,
    period: input.draft.period,
    ranAt: input.asOf,
    verdict: counts.block + counts.review === 0 ? "pass" : "exceptions",
    counts,
    exceptions: sorted,
    summary: {
      headcount: input.draft.employees.length,
      priorHeadcount: input.prior?.employees.length,
      totalGrossCents,
      priorTotalGrossCents: input.prior ? input.prior.employees.reduce((s, e) => s + e.grossCents, 0) : undefined,
      totalNetCents,
      priorTotalNetCents: input.prior ? input.prior.employees.reduce((s, e) => s + e.netCents, 0) : undefined,
      movements: movements(ctx),
    },
  };
}
