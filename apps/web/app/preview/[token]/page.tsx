import { renderPreviewMarkdown, type RunReport } from "@payroll-qa/engine";
import { getClient, getRun } from "@payroll-qa/db";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { day, dollars, when } from "@/lib/format";
import { readPreviewToken } from "@/lib/preview-token";

export const dynamic = "force-dynamic";

/** The client's one page: headcount, totals, every line that moved and why. No exceptions, no sign-in. Expires at cutoff. */
export default async function Preview({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const { token } = await params;
  const { done, error } = await searchParams;
  const t = readPreviewToken(token, env.appSecret);
  if (!t) return <div className="card" style={{ maxWidth: 560, margin: "60px auto" }}><h1>Link expired</h1><p>This preview link is no longer valid. Ask your Novum payroll specialist for a new one.</p></div>;
  const run = await getRun(db(), t.runId);
  const report = run?.qaReport as RunReport | null | undefined;
  if (!run || !report) return <div className="card" style={{ maxWidth: 560, margin: "60px auto" }}><h1>Not available</h1></div>;
  const client = (await getClient(db(), run.clientId))!;
  const approved = !!run.clientApprovedAt;
  return (
    <div style={{ maxWidth: 760, margin: "20px auto" }}>
      <h1>Payroll preview: {client.legalName}</h1>
      <p className="muted">Pay period {day(run.periodStart)} to {day(run.periodEnd)}. Pay date {day(run.payDate)}. Please approve by {when(run.cutoffAt)}.</p>
      {done && <div className="flash ok">Thank you. Your approval was recorded at {when(new Date())}.</div>}
      {error && <div className="flash error">{error}</div>}
      <div className="grid">
        <div className="card"><div className="muted small">Headcount</div><strong>{report.summary.headcount}</strong></div>
        <div className="card"><div className="muted small">Total gross</div><strong>{dollars(report.summary.totalGrossCents)}</strong></div>
        <div className="card"><div className="muted small">Total net</div><strong>{dollars(report.summary.totalNetCents)}</strong></div>
      </div>
      <h2>Lines that moved from the last payroll</h2>
      {report.summary.movements.length === 0 ? <p>No line moved from the prior payroll.</p> : (
        <table>
          <thead><tr><th>Employee</th><th>Prior gross</th><th>Gross</th><th>Change</th><th>Why</th></tr></thead>
          <tbody>
            {report.summary.movements.map((m, i) => (
              <tr key={i}><td>{m.employeeName}</td><td>{m.priorGrossCents !== undefined ? dollars(m.priorGrossCents) : ""}</td><td>{m.grossCents !== undefined ? dollars(m.grossCents) : ""}</td><td>{m.deltaCents > 0 ? "+" : ""}{dollars(m.deltaCents)}</td><td>{m.reason}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card" style={{ marginTop: 20 }}>
        {approved ? (
          <p>Approved by {run.clientApprovedBy} at {when(run.clientApprovedAt)}.</p>
        ) : (
          <form method="post" action={`/preview/${token}/approve`}>
            <label>Your name</label>
            <input name="approvedBy" required placeholder="Name and title" />
            <p className="small muted">By approving you confirm this payroll may be submitted as shown. Anything else must reach your specialist before {when(run.cutoffAt)}.</p>
            <button type="submit">Approve this payroll</button>
          </form>
        )}
      </div>
      <details><summary className="small muted">Plain text</summary><pre>{renderPreviewMarkdown(report)}</pre></details>
    </div>
  );
}
