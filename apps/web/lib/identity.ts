/**
 * The work-account rule, pure and tested. A Microsoft token is admitted only
 * when it was issued by Novum's tenant: `tid` must equal the configured tenant
 * and must not be the personal-account tenant. The email domain is never the
 * test; only the issuer's claim about who administers the account is.
 */
export const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export interface IdTokenClaims {
  tid?: string;
  oid?: string;
  preferred_username?: string;
  email?: string;
  idp?: string;
  name?: string;
}

export function workAccount(claims: IdTokenClaims, tenantId: string): { email: string; oid: string; name?: string } | null {
  if (!claims.tid || claims.tid !== tenantId || claims.tid === PERSONAL_TENANT) return null;
  if (claims.idp && /live\.com/i.test(claims.idp)) return null;
  const email = (claims.preferred_username ?? claims.email ?? "").toLowerCase();
  if (!claims.oid || !email || !email.includes("@")) return null;
  return { email, oid: claims.oid, name: claims.name };
}
