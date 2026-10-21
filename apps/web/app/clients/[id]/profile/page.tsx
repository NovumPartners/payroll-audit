import { notFound } from "next/navigation";
import { getClient, listQuestions, loadProfile, signGate, userById } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { can, canView } from "@/lib/authz";
import { db } from "@/lib/db";
import { dollars, when } from "@/lib/format";
import { draft, resolve, sign } from "../actions";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const { ok, error } = await searchParams;
  const user = await requireUser();
  const database = db();
  const client = await getClient(database, id);
  if (!client) notFound();
  const assigned = client.specialistId === user.id;
  if (!canView(user, assigned)) notFound();
  const [profile, questions, gate] = await Promise.all([loadProfile(database, id), listQuestions(database, id), signGate(database, id)]);
  const signer = client.profileSignedBy ? await userById(database, client.profileSignedBy) : null;
  const openQ = questions.filter((q) => !q.resolvedAt);
  const name = (eid: string | null) => profile?.employees.find((e) => e.id === eid)?.name ?? "";
  const signed = !!client.profileSignedAt;
  return (
    <>
      <h1>Payroll Profile: {client.legalName}</h1>
      <p className="muted"><a href={`/clients/${id}`}>Back to client</a>. {signed ? <>Signed by {signer?.name} at {when(client.profileSignedAt)}{client.profilePdfBoxFileId ? `, PDF filed to Box (${client.profilePdfBoxFileId})` : ""}. Changes arrive through change requests only.</> : "Unsigned. The client goes live only when a specialist signs."}</p>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}

      {!signed && can(user, "draft_profile", assigned) && (
        <div className="card">
          <form action={draft}>
            <input type="hidden" name="clientId" value={client.id} />
            <strong>Build the draft</strong>
            <p className="small muted">Pulls the platform roster and the current draft, reads the Box folder (board resolutions, benefit summaries, offer letters, PTO policies), extracts every stated amount, date and policy with its source file, compares, and writes a question for every disagreement. Re-running replaces the unsigned draft.</p>
            <button type="submit">Draft from {client.platform}{client.boxFolderId ? " and Box" : ""}</button>
          </form>
        </div>
      )}

      {!signed && (
        <div className="card">
          <strong>Signature gate</strong>
          {gate.ok ? <p style={{ color: "var(--ok)" }}>Ready to sign.</p> : <ul>{gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          {can(user, "sign_profile", assigned) && (
            <form action={sign}>
              <input type="hidden" name="clientId" value={client.id} />
              <label><input type="checkbox" name="housingConfirmed" style={{ width: "auto" }} /> I confirmed in {client.platform} that the housing allowance earning type is excluded from taxable wages (C4)</label>
              <p className="small muted">Signing records your name and the time, writes the profile PDF to the client&apos;s Box folder, and moves the client to live. From then on the engine checks every draft against this profile.</p>
              <button type="submit" disabled={!gate.ok}>Sign the profile</button>
            </form>
          )}
        </div>
      )}

      <h2>Questions ({openQ.length} open of {questions.length})</h2>
      {questions.map((q) => (
        <div className="card" key={q.id}>
          <div><strong>{name(q.employeeId) || client.legalName}</strong> · {q.field.replace(/_/g, " ")}</div>
          <div style={{ margin: "4px 0" }}>{q.question}</div>
          <dl>
            {q.platformValue && <><dt>Platform</dt><dd>{q.platformValue}</dd></>}
            {q.documentValue && <><dt>Document</dt><dd>{q.documentValue}{q.sourceDocBoxFileId ? <span className="muted small"> (Box {q.sourceDocBoxFileId})</span> : ""}</dd></>}
          </dl>
          {q.resolvedAt ? (
            <p className="small">Resolved: {q.resolution}{q.resolvedValue ? ` = ${q.resolvedValue}` : ""} at {when(q.resolvedAt)}</p>
          ) : can(user, "resolve_question", assigned) && !signed ? (
            <form action={resolve} style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 6 }}>
              <input type="hidden" name="clientId" value={client.id} /><input type="hidden" name="questionId" value={q.id} />
              <span style={{ flex: 1 }}><label>Corrected value (for &quot;corrected&quot;)</label><input name="value" /></span>
              {q.platformValue && <button type="submit" name="resolution" value="platform" className="secondary">Platform is right</button>}
              {q.documentValue && <button type="submit" name="resolution" value="document" className="secondary">Document is right</button>}
              <button type="submit" name="resolution" value="corrected">Corrected</button>
            </form>
          ) : null}
        </div>
      ))}

      {profile && (
        <>
          <h2>Employees ({profile.employees.length})</h2>
          <table>
            <thead><tr><th>Name</th><th>Platform id</th><th>Status</th><th>Hired</th><th>Pay</th><th>Std hours</th><th>State</th><th>Minister</th><th>FICA exempt</th><th>Fed w/h voluntary</th></tr></thead>
            <tbody>
              {profile.employees.map((e) => (
                <tr key={e.id}><td>{e.name}</td><td className="small">{e.platformEmployeeId}</td><td>{e.status}</td><td>{e.hireDate || <span style={{ color: "var(--block)" }}>missing</span>}</td><td>{e.payType} {dollars(e.rateCents)}</td><td>{e.standardHours || ""}</td><td>{e.workState || <span style={{ color: "var(--block)" }}>missing</span>}</td><td>{e.isMinister ? "yes" : ""}</td><td>{e.ficaExempt ? "yes" : ""}</td><td>{e.fedWithholdingVoluntary ? "yes" : "no"}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>Housing designations</h2>
          <table>
            <thead><tr><th>Minister</th><th>Annual</th><th>Per period</th><th>Resolution</th><th>Effective</th><th>Box file</th></tr></thead>
            <tbody>
              {profile.housingAllowances.length === 0 && <tr><td colSpan={6} className="muted">None.</td></tr>}
              {profile.housingAllowances.map((h, i) => (
                <tr key={i}><td>{name(h.employeeId)}</td><td>{dollars(h.annualAmountCents)}</td><td>{dollars(h.perPeriodAmountCents)}</td><td>{h.resolutionDate}</td><td>{h.effectiveFrom}{h.effectiveTo ? ` to ${h.effectiveTo}` : " onward"}</td><td className="small">{h.resolutionDocId ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>Benefit elections</h2>
          <table>
            <thead><tr><th>Employee</th><th>Plan</th><th>Employee</th><th>Employer</th><th>Treatment</th><th>Effective</th></tr></thead>
            <tbody>
              {profile.benefitElections.length === 0 && <tr><td colSpan={6} className="muted">None.</td></tr>}
              {profile.benefitElections.map((b, i) => (
                <tr key={i}><td>{name(b.employeeId)}</td><td>{b.planName} <span className="small muted">{b.planId}</span></td><td>{dollars(b.employeeDeductionCents)}</td><td>{dollars(b.employerContributionCents)}</td><td>{b.preTax ? "pre-tax" : "post-tax"}</td><td>{b.effectiveFrom}{b.effectiveTo ? ` to ${b.effectiveTo}` : ""}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>Time-off policies</h2>
          <table>
            <thead><tr><th>Policy</th><th>Accrual</th><th>Cap</th><th>Assigned</th></tr></thead>
            <tbody>
              {profile.timeOffPolicies.length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
              {profile.timeOffPolicies.map((t) => (
                <tr key={t.policyName}><td>{t.policyName}</td><td>{t.accrualRateHours}h {t.accrualBasis.replace("_", " ")}</td><td>{t.capHours ?? ""}</td><td className="small">{t.assignedEmployeeIds.map(name).join(", ")}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Registered states: {profile.registeredStates.join(", ") || "none"}. Pay frequency: {profile.payFrequency}.</p>
        </>
      )}
    </>
  );
}
