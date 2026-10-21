import { notFound } from "next/navigation";
import { getPlatformConnection, listClients, listUsers } from "@payroll-qa/db";
import { DEFAULT_CONFIG } from "@payroll-qa/engine";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { when } from "@/lib/format";
import { saveClient, saveUser } from "./actions";

export const dynamic = "force-dynamic";

export default async function Admin({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; client?: string }> }) {
  const user = await requireUser();
  if (!can(user, "admin")) notFound();
  const { ok, error, client: editId } = await searchParams;
  const [users, clients, gusto] = await Promise.all([listUsers(db()), listClients(db()), getPlatformConnection(db(), "gusto")]);
  const editing = clients.find((c) => c.id === editId);
  const gustoApp = !!env.gustoOAuth();
  const connector = gusto?.connectedBy ? users.find((u) => u.id === gusto.connectedBy)?.name : undefined;
  return (
    <>
      <h1>Admin</h1>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}

      <h2>Platform connections</h2>
      <div className="card">
        <strong>Gusto</strong>{" "}
        {gusto ? (
          <span>connected {when(gusto.connectedAt)}{connector ? ` by ${connector}` : ""}; token refreshed {gusto.lastRefreshedAt ? when(gusto.lastRefreshedAt) : "never"}; expires {when(gusto.expiresAt)}.{gusto.lastError ? <span style={{ color: "var(--block)" }}> Last error: {gusto.lastError}</span> : ""}</span>
        ) : env.gusto() ? (
          <span>using the static GUSTO_ACCESS_TOKEN (development only).</span>
        ) : (
          <span className="muted">not connected.</span>
        )}
        {gustoApp ? (
          <p className="small"><a className="btn" href="/auth/gusto/start">{gusto ? "Re-authorize Gusto" : "Connect Gusto"}</a> <span className="muted">Signs in as Novum&apos;s firm admin; read scopes only. Redirect URI registered on the app: {env.baseUrl}/auth/gusto/callback</span></p>
        ) : (
          <p className="small muted">Set GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET to enable the connection.</p>
        )}
      </div>

      <h2>Access list</h2>
      <p className="muted small">Microsoft 365 sign-in admits only these emails. Specialists see assigned clients; reviewers are read-only; leads configure.</p>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Slack id</th><th>Active</th><th>Entra bound</th></tr></thead>
        <tbody>{users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td className="small">{u.slackUserId}</td><td>{u.active ? "yes" : "no"}</td><td>{u.entraOid ? "yes" : ""}</td></tr>)}</tbody>
      </table>
      <form action={saveUser} className="card">
        <strong>Add or update a person</strong>
        <div className="grid">
          <span><label>Email</label><input name="email" type="email" required /></span>
          <span><label>Name</label><input name="name" required /></span>
          <span><label>Role</label><select name="role" defaultValue="specialist"><option value="lead">lead</option><option value="specialist">specialist</option><option value="reviewer">reviewer</option></select></span>
          <span><label>Slack user id</label><input name="slackUserId" placeholder="U0123ABCD" /></span>
          <span><label>Active</label><select name="active" defaultValue="on"><option value="on">yes</option><option value="off">no</option></select></span>
        </div>
        <div style={{ marginTop: 8 }}><button type="submit">Save person</button></div>
      </form>

      <h2>Clients</h2>
      <table>
        <thead><tr><th>Client</th><th>Platform</th><th>Company id</th><th>Status</th><th>Specialist</th><th></th></tr></thead>
        <tbody>{clients.map((c) => <tr key={c.id}><td><a href={`/clients/${c.id}`}>{c.legalName}</a></td><td>{c.platform}</td><td className="small">{c.platformCompanyId}</td><td>{c.status}</td><td>{users.find((u) => u.id === c.specialistId)?.name ?? ""}</td><td><a href={`/admin?client=${c.id}`}>edit</a></td></tr>)}</tbody>
      </table>
      <form action={saveClient} className="card" key={editing?.id ?? "new"}>
        <strong>{editing ? `Edit ${editing.legalName}` : "Add a client"}</strong> {editing && <a href="/admin" className="small">(new instead)</a>}
        <div className="grid">
          <span><label>Legal name</label><input name="legalName" required defaultValue={editing?.legalName} /></span>
          <span><label>Platform</label><select name="platform" defaultValue={editing?.platform ?? "gusto"}><option value="gusto">gusto</option><option value="rippling">rippling</option></select></span>
          <span><label>Platform company id</label><input name="platformCompanyId" required defaultValue={editing?.platformCompanyId} /></span>
          <span><label>Pay frequency</label><select name="payFrequency" defaultValue={editing?.payFrequency ?? "semimonthly"}><option>weekly</option><option>biweekly</option><option>semimonthly</option><option>monthly</option></select></span>
          <span><label>Cutoff days before pay date</label><input name="cutoffDaysBeforePayDate" type="number" defaultValue={editing?.cutoffDaysBeforePayDate ?? 2} /></span>
          <span><label>Cutoff hour (UTC)</label><input name="cutoffHourUtc" type="number" min={0} max={23} defaultValue={editing?.cutoffHourUtc ?? 22} /></span>
          <span><label>Expected pay date lag (days after period end, optional)</label><input name="expectedPayDateLagDays" type="number" defaultValue={editing?.expectedPayDateLagDays ?? ""} /></span>
          <span><label>Box folder id</label><input name="boxFolderId" defaultValue={editing?.boxFolderId ?? ""} /></span>
          <span><label>Specialist</label><select name="specialistId" defaultValue={editing?.specialistId ?? ""}><option value="">unassigned</option>{users.filter((u) => u.role !== "reviewer" && u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></span>
          <span><label>Client contact name</label><input name="contactName" defaultValue={editing?.contactName ?? ""} /></span>
          <span><label>Client contact email</label><input name="contactEmail" type="email" defaultValue={editing?.contactEmail ?? ""} /></span>
          <span><label>Status</label><select name="status" defaultValue={editing?.status ?? "onboarding"}><option>onboarding</option><option>live</option><option>paused</option><option>offboarded</option></select></span>
          <span><label>Registered states (comma separated)</label><input name="registeredStates" defaultValue={editing?.registeredStates.join(", ") ?? ""} /></span>
          <span><label>Clergy present</label><input type="checkbox" name="clergyPresent" style={{ width: "auto" }} defaultChecked={editing?.clergyPresent ?? false} /></span>
          <span><label>Threshold overrides (JSON; defaults {JSON.stringify(DEFAULT_CONFIG)})</label><input name="thresholdOverrides" defaultValue={editing?.thresholdOverrides ? JSON.stringify(editing.thresholdOverrides) : ""} /></span>
          <span><label>Rippling export: next period start</label><input name="nextPeriodStart" type="date" defaultValue={editing?.nextPeriodStart ?? ""} /></span>
          <span><label>Rippling export: next period end</label><input name="nextPeriodEnd" type="date" defaultValue={editing?.nextPeriodEnd ?? ""} /></span>
          <span><label>Rippling export: next pay date</label><input name="nextPayDate" type="date" defaultValue={editing?.nextPayDate ?? ""} /></span>
        </div>
        <div style={{ marginTop: 8 }}><button type="submit">Save client</button></div>
      </form>
    </>
  );
}
