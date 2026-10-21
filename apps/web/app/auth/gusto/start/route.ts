import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { gustoAuthorizeUrl } from "@payroll-qa/adapters";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { env } from "@/lib/env";
import { gustoOAuthConfig, gustoRedirectUri } from "@/lib/gusto-connection";

export const dynamic = "force-dynamic";

/** Lead only: send the firm's payroll admin to Gusto to authorize the app. */
export async function GET() {
  const user = await currentUser();
  if (!user || !can(user, "admin")) return NextResponse.redirect(`${env.baseUrl}/login`);
  const cfg = gustoOAuthConfig();
  if (!cfg) return NextResponse.redirect(`${env.baseUrl}/admin?error=${encodeURIComponent("GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET are not set.")}`);
  const state = randomBytes(16).toString("base64url");
  (await cookies()).set("pqa_gusto_state", state, { httpOnly: true, secure: env.isProduction(), sameSite: "lax", path: "/", maxAge: 600 });
  return NextResponse.redirect(gustoAuthorizeUrl(cfg, gustoRedirectUri(), state));
}
