/**
 * Session cookie: an HS256 JWT signed with APP_SECRET carrying the email and
 * the Entra object id only. Role and scope are read from the access list on
 * every request, so a role change takes effect immediately.
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "pqa_session";
export const SESSION_HOURS = 12;

export interface SessionClaims {
  email: string;
  oid: string;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(claims: SessionClaims, secret: string, now: Date = new Date()): Promise<string> {
  return new SignJWT({ email: claims.email, oid: claims.oid })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + SESSION_HOURS * 3600)
    .setIssuer("payroll-qa")
    .setAudience("payroll-qa")
    .sign(key(secret));
}

export async function verifySession(token: string | undefined, secret: string, now: Date = new Date()): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "payroll-qa", audience: "payroll-qa", currentDate: now });
    if (typeof payload.email !== "string" || typeof payload.oid !== "string") return null;
    return { email: payload.email, oid: payload.oid };
  } catch {
    return null;
  }
}
