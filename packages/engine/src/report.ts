import { dollars } from "./context";
import type { RunReport } from "./types";

/** One-page QA report for the pod. Filed to Box as Markdown, JSON and PDF by the jobs app. */
export function renderReportMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Payroll QA Report: ${r.clientName}`);
  lines.push("");
  lines.push(`Period ${r.period.start} to ${r.period.end}, pay date ${r.period.payDate}. Run ${r.ranAt}. Platform payroll ${r.platformPayrollId}.`);
  lines.push("");
  lines.push(`**Verdict: ${r.verdict === "pass" ? "PASS" : `${r.counts.block} block, ${r.counts.review} review, ${r.counts.info} info`}**`);
  lines.push("");
  lines.push(summaryLine(r));
  lines.push("");
  if (r.exceptions.length === 0) {
    lines.push("No exceptions. Clear to request client approval.");
  } else {
    lines.push("| Severity | Check | Employee | Expected | Actual | Source |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const e of r.exceptions) {
      lines.push(`| ${e.severity} | ${e.checkCode} | ${esc(e.employeeName ?? "")} | ${esc(e.expected)} | ${esc(e.actual)} | ${e.sourceOfExpected} |`);
    }
    lines.push("");
    lines.push("Every block must be cleared or documented before the client preview is sent.");
  }
  if (r.summary.movements.length) {
    lines.push("");
    lines.push("## Lines that moved");
    lines.push("");
    lines.push(movementsTable(r));
  }
  return lines.join("\n");
}

/**
 * The one-page client preview (spec section 06, cutoff minus 1): headcount,
 * total gross, total net, every line that moved and why. No exceptions, no
 * check codes; the client sees the result, not the QA.
 */
export function renderPreviewMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Payroll preview: ${r.clientName}`);
  lines.push("");
  lines.push(`Pay period ${r.period.start} to ${r.period.end}. Pay date ${r.period.payDate}.`);
  lines.push("");
  lines.push(summaryLine(r));
  lines.push("");
  if (r.summary.movements.length === 0) {
    lines.push(r.summary.priorHeadcount === undefined ? "First run on record; no prior period to compare." : "No line moved from the prior period.");
  } else {
    lines.push(movementsTable(r));
  }
  return lines.join("\n");
}

function summaryLine(r: RunReport): string {
  const hc = r.summary.priorHeadcount !== undefined ? `${r.summary.headcount} (prior ${r.summary.priorHeadcount})` : `${r.summary.headcount}`;
  const gross =
    r.summary.priorTotalGrossCents !== undefined
      ? `${dollars(r.summary.totalGrossCents)} (prior ${dollars(r.summary.priorTotalGrossCents)})`
      : dollars(r.summary.totalGrossCents);
  const net =
    r.summary.priorTotalNetCents !== undefined
      ? `${dollars(r.summary.totalNetCents)} (prior ${dollars(r.summary.priorTotalNetCents)})`
      : dollars(r.summary.totalNetCents);
  return `Headcount ${hc}. Total gross ${gross}. Total net ${net}.`;
}

function movementsTable(r: RunReport): string {
  const lines = ["| Employee | Prior gross | Gross | Change | Why |", "| --- | --- | --- | --- | --- |"];
  for (const m of r.summary.movements) {
    lines.push(
      `| ${esc(m.employeeName)} | ${m.priorGrossCents !== undefined ? dollars(m.priorGrossCents) : ""} | ${m.grossCents !== undefined ? dollars(m.grossCents) : ""} | ${m.deltaCents > 0 ? "+" : ""}${dollars(m.deltaCents)} | ${esc(m.reason)} |`,
    );
  }
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}
