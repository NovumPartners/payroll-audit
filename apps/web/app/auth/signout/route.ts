import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const res = NextResponse.redirect(`${env.baseUrl}/login`);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: env.isProduction(), sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
