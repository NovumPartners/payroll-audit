import { dollars } from "./context.js";
import type { RunReport } from "./types.js";

/** One-page QA report. Filed to Box as Markdown and rendered to PDF by the jobs app. */
export function renderReportMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Payroll QA Report: ${r.clientName}`);
  lines.push("");
  lines.push(`Period ${r.period.start} to ${r.period.end}, pay date ${r.period.payDate}. Run ${r.ranAt}. Platform payroll ${r.platformPayrollId}.`);
  lines.push("");
  lines.push(`**Verdict: ${r.verdict === "pass" ? "PASS" : `${r.counts.block} block, ${r.counts.review} review, ${r.counts.info} info`}**`);
  lines.push("");
  const hc = r.summary.priorHeadcount !== undefined ? `${r.summary.headcount} (prior ${r.summary.priorHeadcount})` : `${r.summary.headcount}`;
  const gross =
    r.summary.priorTotalGrossCents !== undefined
      ? `${dollars(r.summary.totalGrossCents)} (prior ${dollars(r.summary.priorTotalGrossCents)})`
      : dollars(r.summary.totalGrossCents);
  lines.push(`Headcount ${hc}. Total gross ${gross}. Total net ${dollars(r.summary.totalNetCents)}.`);
  lines.push("");
  if (r.exceptions.length === 0) {
    lines.push("No exceptions. Clear to request client approval.");
    return lines.join("\n");
  }
  lines.push("| Severity | Check | Employee | Expected | Actual | Source |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const e of r.exceptions) {
    lines.push(
      `| ${e.severity} | ${e.checkCode} | ${e.employeeName ?? ""} | ${esc(e.expected)} | ${esc(e.actual)} | ${e.sourceOfExpected} |`,
    );
  }
  lines.push("");
  lines.push("Every block must be cleared or documented before the client preview is sent.");
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}
