"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { renderPreviewMarkdown, type RunReport } from "@payroll-qa/engine";
import { RepoError, decideException, getClient, getRun, markSubmitted, recordClientApproval, recordNotification, recordPreviewSent, addRunEvent } from "@payroll-qa/db";
import { runQaForClient } from "@payroll-qa/jobs";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { db } from "@/lib/db";
import { buildDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { makePreviewToken } from "@/lib/preview-token";

async function context(runId: string) {
  const user = await requireUser();
  const run = await getRun(db(), runId);
  if (!run) throw new Error("Run not found");
  const client = (await getClient(db(), run.clientId))!;
  const assigned = client.specialistId === user.id;
  return { user, run, client, assigned };
}

function back(runId: string, flash: string, kind: "ok" | "error" = "ok"): never {
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}?${kind}=${encodeURIComponent(flash)}`);
}

function message(err: unknown): string {
  return err instanceof RepoError ? err.message : err instanceof Error ? err.message : String(err);
}

export async function decide(formData: FormData) {
  const runId = String(formData.get("runId"));
  const { user, assigned } = await context(runId);
  if (!can(user, "decide_exception", assigned)) back(runId, "You cannot decide exceptions on this client.", "error");
  const status = String(formData.get("status")) === "documented" ? "documented" : "cleared";
  try {
    await decideException(db(), { exceptionId: String(formData.get("exceptionId")), userId: user.id, status, note: String(formData.get("note") ?? "") });
  } catch (err) {
    back(runId, message(err), "error");
  }
  back(runId, `Exception ${status}.`);
}

export async function rerun(formData: FormData) {
  const runId = String(formData.get("runId"));
  const { user, run, client, assigned } = await context(runId);
  if (!can(user, "rerun_qa", assigned)) back(runId, "You cannot re-run QA on this client.", "error");
  const deps = await buildDeps();
  const clients = await deps.listLiveClients();
  const ctx = clients.find((c) => c.id === client.id);
  if (!ctx) back(runId, "Client is not live.", "error");
  try {
    const outcome = await runQaForClient(deps, ctx, { id: run.id, clientId: run.clientId, period: { start: run.periodStart, end: run.periodEnd, payDate: run.payDate }, cutoffAt: run.cutoffAt, status: run.status, qaAttempt: run.qaAttempt, platformPayrollId: run.platformPayrollId ?? undefined }, { trigger: "manual" });
    await addRunEvent(db(), { runId, kind: "qa_rerun_by", userId: user.id, detail: { status: outcome.status, attempt: outcome.attempt } });
    back(runId, outcome.status === "error" ? `QA failed: ${outcome.error}` : `QA attempt ${outcome.attempt ?? ""}: ${outcome.status}.`, outcome.status === "error" ? "error" : "ok");
  } catch (err) {
    back(runId, message(err), "error");
  }
}

/** Compose the preview: a signed link that expires at cutoff, plus the one-page text, delivered to the specialist to send. */
export async function sendPreview(formData: FormData) {
  const runId = String(formData.get("runId"));
  const { user, run, client, assigned } = await context(runId);
  if (!can(user, "send_preview", assigned)) back(runId, "You cannot send the preview for this client.", "error");
  if (!run.qaReport) back(runId, "Run QA before sending a preview.", "error");
  const token = makePreviewToken(run.id, run.cutoffAt, env.appSecret);
  const link = `${env.baseUrl}/preview/${token}`;
  const md = renderPreviewMarkdown(run.qaReport as RunReport);
  await recordNotification(db(), { clientId: client.id, runId: run.id, audience: "client_contact_via_specialist", recipient: user.email, kind: "preview", text: `Preview for ${client.contactName ?? client.legalName}${client.contactEmail ? ` <${client.contactEmail}>` : ""}. Approval link (expires at cutoff): ${link}\n\n${md}` });
  await recordPreviewSent(db(), { runId: run.id, userId: user.id, channel: "link" });
  back(runId, "Preview composed. Copy it from the inbox and send it to the client.");
}

export async function recordApproval(formData: FormData) {
  const runId = String(formData.get("runId"));
  const { user, assigned } = await context(runId);
  if (!can(user, "record_approval", assigned)) back(runId, "You cannot record approval for this client.", "error");
  const approvedBy = String(formData.get("approvedBy") ?? "").trim();
  if (!approvedBy) back(runId, "Name who approved.", "error");
  try {
    await recordClientApproval(db(), { runId, approvedBy, method: "reply", recordedByUserId: user.id });
  } catch (err) {
    back(runId, message(err), "error");
  }
  back(runId, "Client approval recorded.");
}

export async function submitted(formData: FormData) {
  const runId = String(formData.get("runId"));
  const { user, assigned } = await context(runId);
  if (!can(user, "mark_submitted", assigned)) back(runId, "You cannot record submission for this client.", "error");
  try {
    await markSubmitted(db(), { runId, userId: user.id });
  } catch (err) {
    back(runId, message(err), "error");
  }
  back(runId, "Recorded as submitted. The register is compared to the approved draft the next morning.");
}
