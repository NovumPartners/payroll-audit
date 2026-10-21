import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { gustoExchangeCode } from "@payroll-qa/adapters";
import { audit, savePlatformConnection } from "@payroll-qa/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/authz";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gustoOAuthConfig, gustoRedirectUri } from "@/lib/gusto-connection";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user || !can(user, "admin")) return NextResponse.redirect(`${env.baseUrl}/login`);
  const to = (q: string) => NextResponse.redirect(`${env.baseUrl}/admin?${q}`);
  const jar = await cookies();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = jar.get("pqa_gusto_state")?.value;
  jar.delete("pqa_gusto_state");
  if (!code || !state || !expected || state !== expected) return to("error=" + encodeURIComponent("Gusto authorization did not complete (state mismatch or no code). Try again."));
  const cfg = gustoOAuthConfig();
  if (!cfg) return to("error=" + encodeURIComponent("Gusto OAuth is not configured."));
  try {
    const t = await gustoExchangeCode(cfg, code, gustoRedirectUri());
    await savePlatformConnection(db(), { platform: "gusto", accessTokenEnc: encrypt(t.accessToken, env.appSecret), refreshTokenEnc: encrypt(t.refreshToken, env.appSecret), expiresAt: t.expiresAt, scope: t.scope, connectedBy: user.id });
    await audit(db(), { userId: user.id, action: "platform.connected", detail: { platform: "gusto" } });
    return to("ok=" + encodeURIComponent("Gusto connected. The cycle will pull drafts for live clients on its next tick."));
  } catch (err) {
    console.error("gusto connect failed", err instanceof Error ? err.message : err);
    return to("error=" + encodeURIComponent("Gusto rejected the authorization code. Check the client id, secret and redirect URI registered on the app."));
  }
}
