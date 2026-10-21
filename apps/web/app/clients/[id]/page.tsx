import { notFound } from "next/navigation";
import { getClient, listUsers, loadLedger, loadProfile, listAudit } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { can, canView } from "@/lib/authz";
import { db } from "@/lib/db";
import { day, dollars, when } from "@/lib/format";
import { apply, reject } from "./actions";

export const dynamic = "force-dynamic";

function describe(p: Record<string, unknown>): string {
  const cents = (n: unknown) => (typeof n === "number" ? dollars(n) : "");
  switch (p.kind) {
    case "rate_change": return `new rate ${cents(p.newRateCents)}${p.previousRateCents !== undefined ? ` (was ${cents(p.previousRateCents)})` : ""}`;
    case "new_hire": return `${String(p.name ?? "new hire")}, ${String(p.payType)} at ${cents(p.rateCents)} from ${String(p.hireDate)}`;
    case "termination": return `last day ${String(p.terminationDate)}${p.payoutAccruedTimeOff ? ", pay out accrued time off" : ""}`;
    case "housing_change": return `${cents(p.annualAmountCents)} per year, ${cents(p.perPeriodAmountCents)} per period, resolution ${String(p.resolutionDate)}`;
    case "benefit_change": return `${String(p.planId)}: employee ${cents(p.employeeDeductionCents)}, employer ${cents(p.employerContributionCents)}`;
    case "time_off_change": return `${String(p.policyName)}: ${String(p.accrualRateHours)}h${p.capHours !== undefined ? `, cap ${String(p.capHours)}h` : ""}`;
    case "one_time_pay": return `${String(p.earningType)} ${cents(p.amountCents)}${p.description ? `: ${String(p.description)}` : ""}`;
    case "deduction_change": return `${String(p.deductionName)} ${cents(p.amountCents)}`;
    case "schedule_change": return `pay frequency ${String(p.payFrequency)}`;
    default: return JSON.stringify(p);
  }
}

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const { ok, error } = await searchParams;
  const user = await requireUser();
  const database = db();
  const client = await getClient(database, id);
  if (!client) notFound();
  const assigned = client.specialistId === user.id;
  if (!canView(user, assigned)) notFound();
  const [profile, ledger, users, log] = await Promise.all([loadProfile(database, id), loadLedger(database, id), listUsers(database), listAudit(database, { clientId: id, limit: 50 })]);
  const emp = (eid?: string) => profile?.employees.find((e) => e.id === eid);
  const mayApply = can(user, "apply_request", assigned);
  const received = ledger.filter((r) => r.status === "received");
  const rest = ledger.filter((r) => r.status !== "received").slice().reverse();
  return (
    <>
      <h1>{client.legalName}</h1>
      <p className="muted">{client.platform} · {client.payFrequency} · cutoff {client.cutoffDaysBeforePayDate} days before pay date at {client.cutoffHourUtc}:00 UTC · specialist {users.find((u) => u.id === client.specialistId)?.name ?? "unassigned"} · <a href={`/clients/${id}/profile`}>Payroll Profile</a>{profile?.signedAt ? ` (signed ${when(profile.signedAt)})` : " (unsigned)"}</p>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}

      <h2>Change requests awaiting application ({received.length})</h2>
      {received.length === 0 && <p className="muted">None. Every request with an effective date on or before the period end must be applied before QA, or A5 blocks the run.</p>}
      {received.map((r) => {
        const p = r.payload as unknown as Record<string, unknown>;
        return (
          <div className="card" key={r.id}>
            <div><strong>{r.type.replace(/_/g, " ")}</strong> effective {r.effectiveDate} · {emp(r.employeeId)?.name ?? (r.employeeId ? r.employeeId : "")} · submitted {when(r.submittedAt)} by {r.submittedBy}{r.jotformSubmissionId ? ` · JotForm ${r.jotformSubmissionId}` : ""}</div>
            <div style={{ margin: "4px 0 8px" }}>{describe(p)}</div>
            {mayApply && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <form action={apply} className="card" style={{ flex: 1, minWidth: 320 }}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="requestId" value={r.id} />
                  <strong>Apply to profile</strong>
                  {p.kind === "new_hire" && (
                    <>
                      <label>Platform employee id (after adding the person in {client.platform})</label><input name="platformEmployeeId" required />
                      <label>Name</label><input name="name" defaultValue={String(p.name ?? "")} />
                      <label>Work state</label><input name="workState" defaultValue={String(p.workState ?? "")} required maxLength={2} />
                      <label>Standard hours per period (hourly)</label><input name="standardHours" type="number" step="0.01" />
                      <label><input type="checkbox" name="isMinister" style={{ width: "auto" }} /> Minister</label>
                      <label><input type="checkbox" name="ficaExempt" style={{ width: "auto" }} /> FICA exempt (minister)</label>
                    </>
                  )}
                  {p.kind === "benefit_change" && !profile?.benefitElections.some((b) => b.planId === p.planId) && (
                    <>
                      <label>Plan name (new to the profile)</label><input name="planName" required />
                      <label>Tax treatment</label>
                      <select name="preTax" required defaultValue=""><option value="" disabled>choose</option><option value="pre">pre-tax</option><option value="post">post-tax</option></select>
                    </>
                  )}
                  {p.kind === "time_off_change" && !profile?.timeOffPolicies.some((t) => t.policyName === p.policyName) && (
                    <>
                      <label>Accrual basis (new policy)</label>
                      <select name="accrualBasis" required defaultValue=""><option value="" disabled>choose</option><option value="per_period">per period</option><option value="per_hour">per hour</option><option value="annual_grant">annual grant</option></select>
                    </>
                  )}
                  {p.kind === "housing_change" && (<><label>Box file id of the board resolution</label><input name="resolutionDocBoxFileId" /></>)}
                  <div style={{ marginTop: 8 }}><button type="submit">Apply</button></div>
                </form>
                <form action={reject} className="card" style={{ flex: 1, minWidth: 260 }}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="requestId" value={r.id} />
                  <strong>Reject</strong>
                  <label>Reason (required)</label><input name="reason" required />
                  <div style={{ marginTop: 8 }}><button type="submit" className="secondary">Reject</button></div>
                </form>
              </div>
            )}
          </div>
        );
      })}

      <h2>Ledger</h2>
      <table>
        <thead><tr><th>Effective</th><th>Type</th><th>Employee</th><th>Detail</th><th>Status</th><th>Submitted</th></tr></thead>
        <tbody>
          {rest.length === 0 && <tr><td colSpan={6} className="muted">No history yet.</td></tr>}
          {rest.map((r) => (
            <tr key={r.id}><td>{r.effectiveDate}</td><td>{r.type.replace(/_/g, " ")}</td><td>{emp(r.employeeId)?.name ?? ""}</td><td>{describe(r.payload as unknown as Record<string, unknown>)}</td><td><span className="status">{r.status.replace(/_/g, " ")}</span></td><td className="small">{when(r.submittedAt)} {r.submittedBy}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Audit log</h2>
      <table>
        <thead><tr><th>When</th><th>Action</th><th>Who</th><th>Detail</th></tr></thead>
        <tbody>
          {log.map((a) => (
            <tr key={a.id}><td className="small">{when(a.at)}</td><td>{a.action}</td><td>{users.find((u) => u.id === a.userId)?.name ?? ""}</td><td className="small muted">{a.detail ? JSON.stringify(a.detail) : ""}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
