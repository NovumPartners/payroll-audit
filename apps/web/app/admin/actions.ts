"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { RepoError, upsertClient, upsertUser, audit } from "@payroll-qa/db";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { db } from "@/lib/db";

function back(flash: string, kind: "ok" | "error" = "ok"): never {
  revalidatePath("/admin");
  redirect(`/admin?${kind}=${encodeURIComponent(flash)}`);
}
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return v === null || String(v).trim() === "" ? undefined : String(v).trim();
};

export async function saveUser(formData: FormData) {
  const user = await requireUser();
  if (!can(user, "admin")) back("Lead only.", "error");
  const role = String(formData.get("role"));
  if (!["lead", "specialist", "reviewer"].includes(role)) back("Unknown role.", "error");
  const email = str(formData, "email");
  const name = str(formData, "name");
  if (!email || !name) back("Email and name are required.", "error");
  const row = await upsertUser(db(), { email, name, role: role as "lead" | "specialist" | "reviewer", active: formData.get("active") !== "off", slackUserId: str(formData, "slackUserId") ?? null });
  await audit(db(), { userId: user.id, action: "user.saved", targetId: row.id, detail: { email, role, active: row.active } });
  back(`Saved ${email}.`);
}

export async function saveClient(formData: FormData) {
  const user = await requireUser();
  if (!can(user, "admin")) back("Lead only.", "error");
  const legalName = str(formData, "legalName");
  const platform = str(formData, "platform") as "gusto" | "rippling" | undefined;
  const platformCompanyId = str(formData, "platformCompanyId");
  const payFrequency = str(formData, "payFrequency") as "weekly" | "biweekly" | "semimonthly" | "monthly" | undefined;
  if (!legalName || !platform || !platformCompanyId || !payFrequency) back("Name, platform, platform company id and frequency are required.", "error");
  let overrides: Record<string, number | string> | undefined;
  const raw = str(formData, "thresholdOverrides");
  if (raw) {
    try {
      overrides = JSON.parse(raw) as Record<string, number | string>;
    } catch {
      back("Threshold overrides must be JSON, for example {\"grossMovePct\": 0.03}.", "error");
    }
  }
  try {
    const row = await upsertClient(db(), {
      legalName,
      platform,
      platformCompanyId,
      payFrequency,
      cutoffDaysBeforePayDate: Number(str(formData, "cutoffDaysBeforePayDate") ?? 2),
      cutoffHourUtc: Number(str(formData, "cutoffHourUtc") ?? 22),
      expectedPayDateLagDays: str(formData, "expectedPayDateLagDays") ? Number(str(formData, "expectedPayDateLagDays")) : null,
      boxFolderId: str(formData, "boxFolderId") ?? null,
      specialistId: str(formData, "specialistId") ?? null,
      contactName: str(formData, "contactName") ?? null,
      contactEmail: str(formData, "contactEmail") ?? null,
      status: (str(formData, "status") as "onboarding" | "live" | "paused" | "offboarded" | undefined) ?? "onboarding",
      clergyPresent: formData.get("clergyPresent") === "on",
      registeredStates: (str(formData, "registeredStates") ?? "").split(/[,\s]+/).filter(Boolean).map((s) => s.toUpperCase()),
      thresholdOverrides: overrides ?? null,
      nextPeriodStart: str(formData, "nextPeriodStart") ?? null,
      nextPeriodEnd: str(formData, "nextPeriodEnd") ?? null,
      nextPayDate: str(formData, "nextPayDate") ?? null,
    });
    await audit(db(), { userId: user.id, action: "client.saved", clientId: row.id, targetId: row.id, detail: { legalName, status: row.status } });
  } catch (err) {
    back(err instanceof RepoError || err instanceof Error ? err.message : String(err), "error");
  }
  back(`Saved ${legalName}.`);
}
