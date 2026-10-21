/**
 * The client preview link: `runId.expires.signature`, HMAC-SHA256 over the
 * first two with APP_SECRET, expiring at cutoff. Nothing is stored; the
 * signature and the expiry are the whole credential, and approval through it
 * is still refused by the repository after cutoff or with an open block.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function sig(runId: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`${runId}.${exp}`).digest("base64url");
}

export function makePreviewToken(runId: string, expiresAt: Date, secret: string): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${runId}.${exp}.${sig(runId, exp, secret)}`;
}

export function readPreviewToken(token: string, secret: string, now: Date = new Date()): { runId: string; expiresAt: Date } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [runId, expStr, given] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!/^[0-9a-f-]{36}$/.test(runId) || !Number.isInteger(exp)) return null;
  const expected = sig(runId, exp, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (exp * 1000 <= now.getTime()) return null;
  return { runId, expiresAt: new Date(exp * 1000) };
}
