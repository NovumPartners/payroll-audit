/**
 * Microsoft Entra ID, authorization code flow with PKCE, single tenant.
 * The id_token is verified against the tenant's JWKS (issuer, audience,
 * signature) and then held to the work-account rule in identity.ts.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { workAccount, type IdTokenClaims } from "./identity";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const authority = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`;

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(cfg: EntraConfig, redirectUri: string, state: string, challenge: string, nonce: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${authority(cfg.tenantId)}/oauth2/v2.0/authorize?${p}`;
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Exchange the code, verify the id_token, apply the work-account rule. Returns null for a non-work account. */
export async function completeSignIn(cfg: EntraConfig, args: { code: string; redirectUri: string; verifier: string; nonce: string; fetchImpl?: typeof fetch }) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${authority(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "authorization_code", code: args.code, redirect_uri: args.redirectUri, code_verifier: args.verifier }),
  });
  if (!res.ok) throw new Error(`Entra token endpoint ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Entra returned no id_token");
  let set = jwks.get(cfg.tenantId);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.tenantId}/discovery/v2.0/keys`));
    jwks.set(cfg.tenantId, set);
  }
  const { payload } = await jwtVerify(json.id_token, set, { issuer: `${authority(cfg.tenantId)}`, audience: cfg.clientId });
  if (payload.nonce !== args.nonce) throw new Error("Entra nonce mismatch");
  return workAccount(payload as IdTokenClaims, cfg.tenantId);
}
