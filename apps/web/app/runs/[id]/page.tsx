import { notFound } from "next/navigation";
import { renderPreviewMarkdown, type RunReport } from "@payroll-qa/engine";
import { getClient, getRun, latestExceptions, listRunEvents, logExceptionsRead, userById } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { can, canView } from "@/lib/authz";
import { db } from "@/lib/db";
import { day, dollars, when } from "@/lib/format";
import { decide, recordApproval, rerun, sendPreview, submitted } from "./actions";

export const dynamic = "force-dynamic";

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const { ok, error } = await searchParams;
  const user = await requireUser();
  const database = db();
  const run = await getRun(database, id);
  if (!run) notFound();
  const client = (await getClient(database, run.clientId))!;
  const assigned = client.specialistId === user.id;
  if (!canView(user, assigned)) notFound();
  await logExceptionsRead(database, { runId: run.id, clientId: client.id, userId: user.id });
  const [exceptions, events] = await Promise.all([latestExceptions(database, run.id), listRunEvents(database, run.id)]);
  const deciders = new Map<string, string>();
  for (const e of exceptions) if (e.clearedBy && !deciders.has(e.clearedBy)) deciders.set(e.clearedBy, (await userById(database, e.clearedBy))?.name ?? "");
  const report = run.qaReport as RunReport | null;
  const open = exceptions.filter((e) => e.status === "open");
  const openBlock = open.filter((e) => e.severity === "block").length;
  const mayDecide = can(user, "decide_exception", assigned) && run.status !== "submitted";
  const post = exceptions.filter((e) => e.kind === "post_submit");
  return (
    <>
      <h1>{client.legalName} <span className={`status ${run.status}`}>{run.status.replace(/_/g, " ")}</span></h1>
      <p className="muted">
        Period {day(run.periodStart)} to {day(run.periodEnd)}, pay date {day(run.payDate)}, cutoff {when(run.cutoffAt)}. QA attempt {run.qaAttempt}{run.qaRanAt ? ` at ${when(run.qaRanAt)}` : ""}. <a href={`/clients/${client.id}`}>Client</a>
      </p>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}

      {report && (
        <div className="grid">
          <div className="card"><div className="muted small">Headcount</div><strong>{report.summary.headcount}</strong>{report.summary.priorHeadcount !== undefined && <span className="muted"> (prior {report.summary.priorHeadcount})</span>}</div>
          <div className="card"><div className="muted small">Total gross</div><strong>{dollars(report.summary.totalGrossCents)}</strong>{report.summary.priorTotalGrossCents !== undefined && <span className="muted"> (prior {dollars(report.summary.priorTotalGrossCents)})</span>}</div>
          <div className="card"><div className="muted small">Total net</div><strong>{dollars(report.summary.totalNetCents)}</strong>{report.summary.priorTotalNetCents !== undefined && <span className="muted"> (prior {dollars(report.summary.priorTotalNetCents)})</span>}</div>
          <div className="card"><div className="muted small">Open</div><strong style={{ color: openBlock ? "var(--block)" : "var(--ok)" }}>{openBlock} block</strong>, {open.filter((e) => e.severity === "review").length} review, {open.filter((e) => e.severity === "info").length} info</div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Actions</h3>
        {run.status === "submitted" ? (
          <p className="muted">Submitted {when(run.submittedAt)}. {run.submittedComparedAt ? `Register compared ${when(run.submittedComparedAt)}: ${post.length} difference${post.length === 1 ? "" : "s"}.` : "Register comparison pending (next morning)."}</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            {can(user, "rerun_qa", assigned) && (
              <form action={rerun} className="inline"><input type="hidden" name="runId" value={run.id} /><button type="submit">{run.qaAttempt ? "Re-run QA" : "Run QA now"}</button></form>
            )}
            {can(user, "send_preview", assigned) && run.qaAttempt > 0 && (
              <form action={sendPreview} className="inline"><input type="hidden" name="runId" value={run.id} /><button type="submit" className="secondary" disabled={openBlock > 0} title={openBlock ? "Clear or document every block first" : ""}>Compose client preview</button></form>
            )}
            {can(user, "record_approval", assigned) && run.status !== "client_approved" && run.qaAttempt > 0 && (
              <form action={recordApproval} className="inline" style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
                <input type="hidden" name="runId" value={run.id} />
                <span><label>Approved by (reply)</label><input name="approvedBy" placeholder="name or email" style={{ width: 220 }} required /></span>
                <button type="submit" className="secondary" disabled={openBlock > 0}>Record approval</button>
              </form>
            )}
            {can(user, "mark_submitted", assigned) && run.status === "client_approved" && (
              <form action={submitted} className="inline"><input type="hidden" name="runId" value={run.id} /><button type="submit">I submitted in {client.platform}</button></form>
            )}
          </div>
        )}
        {run.clientApprovedAt && <p className="small muted">Client approval: {run.clientApprovedBy} by {run.clientApprovalMethod} at {when(run.clientApprovedAt)}.</p>}
        {run.previewSentAt && !run.clientApprovedAt && <p className="small muted">Preview composed {when(run.previewSentAt)}.</p>}
      </div>

      <h2>Exceptions{run.qaAttempt ? ` (attempt ${run.qaAttempt})` : ""}</h2>
      {!run.qaAttempt && <p className="muted">QA has not run for this period yet. It runs two days before cutoff, or now with the button above.</p>}
      {run.qaAttempt > 0 && exceptions.filter((e) => e.kind === "qa").length === 0 && <div className="flash ok">No exceptions. Clear to request client approval.</div>}
      {exceptions.filter((e) => e.kind === "qa").map((e) => (
        <div className="card" key={e.id}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span className={`sev ${e.severity}`}>{e.severity}</span>
            <strong>{e.checkCode}</strong>
            <span>{report?.exceptions.find((x) => x.checkCode === e.checkCode && x.expected === e.expected && x.actual === e.actual)?.employeeName ?? ""}</span>
            <span className="muted small" style={{ marginLeft: "auto" }}>source: {e.sourceOfExpected.replace("_", " ")}{e.requestId ? ` · request ${e.requestId}` : ""}</span>
          </div>
          <dl style={{ marginTop: 8 }}>
            <dt>Expected</dt><dd>{e.expected}</dd>
            <dt>Actual</dt><dd>{e.actual}</dd>
            <dt>Why</dt><dd>{e.description}</dd>
            {e.priorNote && <><dt>History</dt><dd className="small">{e.priorNote}</dd></>}
          </dl>
          {e.status !== "open" ? (
            <p className="small" style={{ marginBottom: 0 }}><strong>{e.status}</strong> by {deciders.get(e.clearedBy ?? "") || "—"} at {when(e.clearedAt)}: {e.clearanceNote}</p>
          ) : mayDecide ? (
            <form action={decide} style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 8 }}>
              <input type="hidden" name="runId" value={run.id} />
              <input type="hidden" name="exceptionId" value={e.id} />
              <span style={{ flex: 1 }}><label>Note (required)</label><input name="note" required placeholder={e.severity === "block" ? "What was corrected in the platform, or why this stands" : "What was confirmed"} /></span>
              <button type="submit" name="status" value="cleared" title="Corrected in the platform; the next QA run confirms it">Cleared</button>
              <button type="submit" name="status" value="documented" className="secondary" title="Stands as is; the note is the record">Documented</button>
            </form>
          ) : null}
        </div>
      ))}

      {post.length > 0 && (
        <>
          <h2>Post-submit differences</h2>
          {post.map((e) => (
            <div className="card" key={e.id}>
              <div><span className="sev block">post-submit</span> <strong>{e.actual}</strong></div>
              <div className="small muted">Approved: {e.expected}</div>
              {e.status === "open" && mayDecide && (
                <form action={decide} style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 8 }}>
                  <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="exceptionId" value={e.id} />
                  <span style={{ flex: 1 }}><label>Note (required)</label><input name="note" required /></span>
                  <button type="submit" name="status" value="documented" className="secondary">Documented</button>
                </form>
              )}
              {e.status !== "open" && <p className="small">{e.status}: {e.clearanceNote}</p>}
            </div>
          ))}
        </>
      )}

      {report && report.summary.movements.length > 0 && (
        <>
          <h2>Lines that moved</h2>
          <table>
            <thead><tr><th>Employee</th><th>Prior gross</th><th>Gross</th><th>Change</th><th>Why</th></tr></thead>
            <tbody>
              {report.summary.movements.map((m, i) => (
                <tr key={i}><td>{m.employeeName}</td><td>{m.priorGrossCents !== undefined ? dollars(m.priorGrossCents) : ""}</td><td>{m.grossCents !== undefined ? dollars(m.grossCents) : ""}</td><td>{m.deltaCents > 0 ? "+" : ""}{dollars(m.deltaCents)}</td><td>{m.reason}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {report && (
        <details style={{ marginTop: 20 }}>
          <summary>Client preview text</summary>
          <pre>{renderPreviewMarkdown(report)}</pre>
        </details>
      )}

      <h2>Run log</h2>
      <table>
        <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
        <tbody>
          {events.map((ev) => (
            <tr key={ev.id}><td className="small">{when(ev.at)}</td><td>{ev.kind.replace("stage:", "stage ").replace(/_/g, " ")}</td><td className="small muted">{ev.detail ? JSON.stringify(ev.detail) : ""}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
