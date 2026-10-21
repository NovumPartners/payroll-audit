import { listQueue } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { day, when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Queue({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const { all } = await searchParams;
  const scoped = user.role === "specialist" && all !== "1";
  const rows = await listQueue(db(), { asOf: new Date(), specialistId: scoped ? user.id : undefined });
  return (
    <>
      <h1>Exceptions queue</h1>
      <p className="muted">
        Sorted by cutoff, then open blocks. {scoped ? <>Your clients. <a href="/?all=1">Show the whole pod</a></> : user.role === "specialist" ? <a href="/">Show mine</a> : "Whole pod."}
      </p>
      <table>
        <thead>
          <tr><th>Client</th><th>Pay date</th><th>Cutoff</th><th>Days to cutoff</th><th>Open block</th><th>Open review</th><th>Specialist</th><th>Status</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="muted">No runs in the window. Runs appear when the cycle tick finds a client&apos;s next pay period.</td></tr>}
          {rows.map((r) => (
            <tr key={r.runId}>
              <td><a href={`/runs/${r.runId}`}>{r.clientName}</a></td>
              <td>{day(r.payDate)}</td>
              <td>{when(r.cutoffAt)}</td>
              <td>{r.daysToCutoff}</td>
              <td>{r.openBlock > 0 ? <strong style={{ color: "var(--block)" }}>{r.openBlock}</strong> : r.qaAttempt ? 0 : "—"}</td>
              <td>{r.openReview > 0 ? <strong style={{ color: "var(--review)" }}>{r.openReview}</strong> : r.qaAttempt ? 0 : "—"}</td>
              <td>{r.specialistName ?? <span className="muted">unassigned</span>}</td>
              <td><span className={`status ${r.status}`}>{r.status.replace(/_/g, " ")}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
