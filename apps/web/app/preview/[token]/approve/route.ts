import { NextResponse, type NextRequest } from "next/server";
import { RepoError, recordClientApproval } from "@payroll-qa/db";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { readPreviewToken } from "@/lib/preview-token";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = readPreviewToken(token, env.appSecret);
  const to = (q: string) => NextResponse.redirect(`${env.baseUrl}/preview/${token}?${q}`, 303);
  if (!t) return to("error=expired");
  const form = await req.formData();
  const approvedBy = String(form.get("approvedBy") ?? "").trim().slice(0, 200);
  if (!approvedBy) return to("error=" + encodeURIComponent("Please enter your name."));
  try {
    await recordClientApproval(db(), { runId: t.runId, approvedBy, method: "link" });
    return to("done=1");
  } catch (err) {
    const m = err instanceof RepoError ? (err.code === "already_approved" ? "This payroll is already approved." : err.code === "blocks_open" ? "This payroll is still being reviewed by your specialist; please try again shortly." : err.code === "expired" ? "The approval window closed at cutoff." : err.message) : "Approval could not be recorded.";
    return to("error=" + encodeURIComponent(m));
  }
}
