"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { RepoError, applyChangeRequest, getClient, rejectChangeRequest, resolveQuestion, setProfilePdf, signProfile, loadProfile, type ApplyExtras } from "@payroll-qa/db";
import { draftProfileForClient } from "@payroll-qa/profile-builder";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { db } from "@/lib/db";
import { buildDeps, docs } from "@/lib/deps";
import { env } from "@/lib/env";
import { renderPdf } from "@/lib/pdf";
import { readDocumentText } from "@/lib/documents";
import { renderProfileMarkdown } from "@/lib/profile-markdown";

async function context(clientId: string) {
  const user = await requireUser();
  const client = await getClient(db(), clientId);
  if (!client) throw new Error("Client not found");
  return { user, client, assigned: client.specialistId === user.id };
}

function back(path: string, flash: string, kind: "ok" | "error" = "ok"): never {
  revalidatePath(path);
  redirect(`${path}?${kind}=${encodeURIComponent(flash)}`);
}

const message = (err: unknown) => (err instanceof RepoError || err instanceof Error ? err.message : String(err));
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return v === null || String(v).trim() === "" ? undefined : String(v).trim();
};

export async function apply(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const path = `/clients/${clientId}`;
  const { user, assigned } = await context(clientId);
  if (!can(user, "apply_request", assigned)) back(path, "You cannot apply requests for this client.", "error");
  const preTax = str(formData, "preTax");
  const extras: ApplyExtras = {
    platformEmployeeId: str(formData, "platformEmployeeId"),
    name: str(formData, "name"),
    workState: str(formData, "workState"),
    standardHours: str(formData, "standardHours") ? Number(str(formData, "standardHours")) : undefined,
    isMinister: formData.get("isMinister") === "on" ? true : undefined,
    ficaExempt: formData.get("ficaExempt") === "on" ? true : undefined,
    planName: str(formData, "planName"),
    preTax: preTax === undefined ? undefined : preTax === "pre",
    accrualBasis: str(formData, "accrualBasis") as ApplyExtras["accrualBasis"],
    resolutionDocBoxFileId: str(formData, "resolutionDocBoxFileId"),
  };
  try {
    await applyChangeRequest(db(), { requestId: String(formData.get("requestId")), userId: user.id, extras });
  } catch (err) {
    back(path, message(err), "error");
  }
  back(path, "Request applied to the profile.");
}

export async function reject(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const path = `/clients/${clientId}`;
  const { user, assigned } = await context(clientId);
  if (!can(user, "apply_request", assigned)) back(path, "You cannot reject requests for this client.", "error");
  try {
    await rejectChangeRequest(db(), { requestId: String(formData.get("requestId")), userId: user.id, reason: String(formData.get("reason") ?? "") });
  } catch (err) {
    back(path, message(err), "error");
  }
  back(path, "Request rejected.");
}

export async function resolve(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const path = `/clients/${clientId}/profile`;
  const { user, assigned } = await context(clientId);
  if (!can(user, "resolve_question", assigned)) back(path, "You cannot resolve questions for this client.", "error");
  const resolution = String(formData.get("resolution")) as "platform" | "document" | "corrected";
  try {
    await resolveQuestion(db(), { questionId: String(formData.get("questionId")), userId: user.id, resolution, value: str(formData, "value") });
  } catch (err) {
    back(path, message(err), "error");
  }
  back(path, "Question resolved.");
}

export async function sign(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const path = `/clients/${clientId}/profile`;
  const { user, client, assigned } = await context(clientId);
  if (!can(user, "sign_profile", assigned)) back(path, "You cannot sign this profile.", "error");
  try {
    await signProfile(db(), { clientId, userId: user.id, housingEarningTypeConfirmedExcluded: formData.get("housingConfirmed") === "on" });
    const profile = (await loadProfile(db(), clientId))!;
    if (client.boxFolderId) {
      const pdf = await renderPdf(renderProfileMarkdown(profile, user.name), `Payroll Profile ${client.legalName}`);
      const fileId = await docs().put(client.boxFolderId, `Payroll Profile signed ${new Date().toISOString().slice(0, 10)}.pdf`, pdf, "application/pdf");
      await setProfilePdf(db(), clientId, fileId);
    }
  } catch (err) {
    back(path, message(err), "error");
  }
  back(path, client.boxFolderId ? "Profile signed and filed to Box." : "Profile signed. No Box folder is set, so no PDF was filed.");
}

/** Steps 1 to 4 of the profile builder: platform pull, Box documents read and extracted, comparison, questions. */
export async function draft(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const path = `/clients/${clientId}/profile`;
  const { user, client, assigned } = await context(clientId);
  if (!can(user, "draft_profile", assigned)) back(path, "You cannot draft this profile.", "error");
  if (client.profileSignedAt) back(path, "The profile is signed; changes arrive through change requests.", "error");
  try {
    const deps = await buildDeps();
    const result = await draftProfileForClient({
      db: db(),
      client: { id: client.id, name: client.legalName, platform: client.platform, platformCompanyId: client.platformCompanyId, boxFolderId: client.boxFolderId ?? undefined, registeredStates: client.registeredStates },
      adapter: deps.adapter(client.platform),
      docs: docs(),
      readDocumentText,
      anthropicApiKey: env.anthropicApiKey(),
      now: new Date(),
    });
    back(path, `Draft built: ${result.employees} employees, ${result.documents} documents read, ${result.facts} facts extracted, ${result.questions} questions.`);
  } catch (err) {
    back(path, message(err), "error");
  }
}
