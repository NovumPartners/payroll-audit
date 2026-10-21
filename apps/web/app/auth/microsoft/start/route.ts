import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { authorizeUrl, pkcePair } from "@/lib/microsoft";

export const dynamic = "force-dynamic";

export async function GET() {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const jar = await cookies();
  const opts = { httpOnly: true, secure: env.isProduction(), sameSite: "lax" as const, path: "/", maxAge: 600 };
  jar.set("pqa_pkce", verifier, opts);
  jar.set("pqa_state", state, opts);
  jar.set("pqa_nonce", nonce, opts);
  return NextResponse.redirect(authorizeUrl(env.entra, `${env.baseUrl}/auth/microsoft/callback`, state, challenge, nonce));
}
