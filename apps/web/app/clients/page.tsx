import { listClients, listUsers } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Clients() {
  const user = await requireUser();
  const [clients, users] = await Promise.all([listClients(db(), user.role === "specialist" ? { specialistId: user.id } : {}), listUsers(db())]);
  const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? "";
  return (
    <>
      <h1>Clients</h1>
      <table>
        <thead><tr><th>Client</th><th>Platform</th><th>Frequency</th><th>Status</th><th>Profile</th><th>Specialist</th></tr></thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td><a href={`/clients/${c.id}`}>{c.legalName}</a></td>
              <td>{c.platform}</td>
              <td>{c.payFrequency}</td>
              <td><span className="status">{c.status}</span></td>
              <td>{c.profileSignedAt ? <span style={{ color: "var(--ok)" }}>signed {when(c.profileSignedAt)}</span> : <a href={`/clients/${c.id}/profile`}>unsigned</a>}</td>
              <td>{name(c.specialistId) || <span className="muted">unassigned</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
