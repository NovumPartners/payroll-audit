import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Refuse when the secret is unset. */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
