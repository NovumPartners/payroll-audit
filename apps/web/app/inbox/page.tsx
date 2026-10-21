import { listNotifications } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Inbox() {
  await requireUser();
  const rows = await listNotifications(db(), { limit: 200 });
  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">Every message the system composed: reminders, digests, escalations, and the client reminder drafts a specialist sends. Slack delivery status is shown; nothing goes to a client directly.</p>
      <table>
        <thead><tr><th>When</th><th>Kind</th><th>Audience</th><th>Recipient</th><th>Message</th><th>Delivery</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="muted">Nothing yet.</td></tr>}
          {rows.map((n) => (
            <tr key={n.id}>
              <td className="small">{when(n.createdAt)}</td>
              <td className="small">{n.kind}</td>
              <td className="small">{n.audience.replace(/_/g, " ")}</td>
              <td className="small">{n.recipient || <span className="muted">none</span>}</td>
              <td>{n.runId ? <a href={`/runs/${n.runId}`}>{n.text}</a> : n.text}</td>
              <td className="small">{n.deliveredAt ? `Slack ${when(n.deliveredAt)}` : n.deliveryError ? <span style={{ color: "var(--block)" }}>{n.deliveryError}</span> : "recorded"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
