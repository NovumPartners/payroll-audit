import { buildContext } from "./context.js";
import { familyA } from "./checks/familyA.js";
import { familyB } from "./checks/familyB.js";
import { familyC } from "./checks/familyC.js";
import { familyD } from "./checks/familyD.js";
import type { Check, Exception, RunInput, RunReport } from "./types.js";

export * from "./types.js";
export { buildContext, dollars } from "./context.js";
export { renderReportMarkdown } from "./report.js";

export const ALL_CHECKS: Check[] = [...familyA, ...familyB, ...familyC, ...familyD];

const severityRank = { block: 0, review: 1, info: 2 } as const;

export function runChecks(input: RunInput, checks: Check[] = ALL_CHECKS): RunReport {
  const ctx = buildContext(input);
  const exceptions: Exception[] = [];
  for (const check of checks) {
    for (const e of check.run(ctx)) exceptions.push(e);
  }
  exceptions.sort((a, b) => {
    const s = severityRank[a.severity] - severityRank[b.severity];
    if (s !== 0) return s;
    const n = (a.employeeName ?? "").localeCompare(b.employeeName ?? "");
    return n !== 0 ? n : a.checkCode.localeCompare(b.checkCode);
  });
  const counts = { block: 0, review: 0, info: 0 };
  for (const e of exceptions) counts[e.severity]++;
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
    exceptions,
    summary: {
      headcount: input.draft.employees.length,
      priorHeadcount: input.prior?.employees.length,
      totalGrossCents,
      priorTotalGrossCents: input.prior ? input.prior.employees.reduce((s, e) => s + e.grossCents, 0) : undefined,
      totalNetCents,
    },
  };
}
