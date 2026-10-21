import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { userByEmail } from "@payroll-qa/db";
import { db } from "./db";
import { env } from "./env";
import { SESSION_COOKIE, verifySession } from "./session";
import type { User } from "./authz";

/** The signed-in person from the cookie and the access list, or null. Role is read fresh on every request. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = await verifySession(token, env.appSecret);
  if (!claims) return null;
  const u = await userByEmail(db(), claims.email);
  if (!u || !u.active || (u.entraOid && u.entraOid !== claims.oid)) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}
