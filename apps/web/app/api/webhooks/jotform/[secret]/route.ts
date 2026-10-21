/**
 * JotForm webhook. JotForm posts multipart form data; the URL carries a shared
 * secret segment compared in constant time. A duplicate delivery inserts
 * nothing (unique index on the submission id). Mapping failures are logged and
 * answered 200 with the reason so JotForm does not retry forever; the failure
 * is also recorded in the audit log for the lead to see.
 */
import { NextResponse, type NextRequest } from "next/server";
import { JotFormMapper, verifySharedSecret } from "@payroll-qa/adapters";
import { audit, insertChangeRequest, listClients } from "@payroll-qa/db";
import { employees as employeesTable } from "@payroll-qa/db";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { parseJotformForms } from "@/lib/jotform-config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  if (!verifySharedSecret(secret, env.jotformSecret())) return new NextResponse("forbidden", { status: 403 });
  const form = await req.formData();
  const raw = { formID: String(form.get("formID") ?? ""), submissionID: String(form.get("submissionID") ?? ""), rawRequest: String(form.get("rawRequest") ?? "{}"), created_at: form.get("created_at") ? String(form.get("created_at")) : undefined };
  if (!raw.formID || !raw.submissionID) return NextResponse.json({ ok: false, reason: "formID and submissionID are required" }, { status: 400 });
  const maps = parseJotformForms(env.jotformForms());
  const database = db();
  const clients = await listClients(database);
  const byKey = new Map<string, string>();
  for (const c of clients) {
    byKey.set(c.id.toLowerCase(), c.id);
    byKey.set(c.legalName.trim().toLowerCase(), c.id);
    byKey.set(`${c.platform}:${c.platformCompanyId}`.toLowerCase(), c.id);
  }
  const employeeCache = new Map<string, { id: string; platformEmployeeId: string; name: string }[]>();
  const mapper = new JotFormMapper(maps, {
    clientId: (key) => byKey.get(key.trim().toLowerCase()),
    employeeId: (clientId, key) => {
      const list = employeeCache.get(clientId);
      const k = key.trim().toLowerCase();
      return list?.find((e) => e.platformEmployeeId.toLowerCase() === k || e.name.trim().toLowerCase() === k || e.id.toLowerCase() === k)?.id;
    },
  });
  if (!mapper.knowsForm(raw.formID)) {
    await audit(database, { action: "jotform.unknown_form", detail: { formID: raw.formID, submissionID: raw.submissionID } });
    return NextResponse.json({ ok: false, reason: "form not registered" }, { status: 200 });
  }
  try {
    // resolve the client first so the employee lookup can be scoped
    const a = JSON.parse(raw.rawRequest) as Record<string, unknown>;
    const map = maps.find((m) => m.formId === raw.formID)!;
    const clientId = byKey.get(String(a[map.clientKey] ?? "").trim().toLowerCase());
    if (clientId) employeeCache.set(clientId, await database.select({ id: employeesTable.id, platformEmployeeId: employeesTable.platformEmployeeId, name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.clientId, clientId)));
    const cr = mapper.toChangeRequest(raw);
    const { id: _id, ...rest } = cr;
    const result = await insertChangeRequest(database, rest);
    await audit(database, { action: result.inserted ? "jotform.received" : "jotform.duplicate", clientId: cr.clientId, targetId: result.id ?? null, detail: { submissionID: raw.submissionID, type: cr.type } });
    return NextResponse.json({ ok: true, inserted: result.inserted });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit(database, { action: "jotform.rejected", detail: { formID: raw.formID, submissionID: raw.submissionID, reason } });
    return NextResponse.json({ ok: false, reason }, { status: 200 });
  }
}
