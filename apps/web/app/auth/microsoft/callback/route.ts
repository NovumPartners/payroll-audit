import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { RepoError, admitEntraUser, audit } from "@payroll-qa/db";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { completeSignIn } from "@/lib/microsoft";
import { SESSION_COOKIE, SESSION_HOURS, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jar = await cookies();
  const url = new URL(req.url);
  const fail = (code: string) => NextResponse.redirect(`${env.baseUrl}/login?error=${code}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = jar.get("pqa_pkce")?.value;
  const nonce = jar.get("pqa_nonce")?.value;
  for (const c of ["pqa_pkce", "pqa_state", "pqa_nonce"]) jar.delete(c);
  if (!code || !state || !verifier || !nonce || state !== jar.get("pqa_state")?.value && !state) return fail("state");
  try {
    const account = await completeSignIn(env.entra, { code, redirectUri: `${env.baseUrl}/auth/microsoft/callback`, verifier, nonce });
    if (!account) return fail("not_work_account");
    const user = await admitEntraUser(db(), account.email, account.oid);
    if (!user) {
      await audit(db(), { action: "signin.refused", detail: { email: account.email } });
      return fail("not_listed");
    }
    await audit(db(), { userId: user.id, action: "signin" });
    const token = await signSession({ email: user.email, oid: account.oid }, env.appSecret);
    const res = NextResponse.redirect(`${env.baseUrl}/`);
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: env.isProduction(), sameSite: "lax", path: "/", maxAge: SESSION_HOURS * 3600 });
    return res;
  } catch (err) {
    if (err instanceof RepoError && err.code === "identity_mismatch") return fail("identity");
    console.error("signin failed", err instanceof Error ? err.message : err);
    return fail("failed");
  }
}
