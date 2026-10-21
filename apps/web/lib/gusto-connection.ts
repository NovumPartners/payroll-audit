/**
 * The firm's Gusto connection: tokens encrypted in platform_connections,
 * refreshed five minutes before expiry, the rotated pair persisted before any
 * request proceeds. A static GUSTO_ACCESS_TOKEN still works for a demo
 * company; the OAuth connection takes precedence when present.
 */
import { GustoAdapter, gustoTokenProvider, type GustoOAuthConfig, type TokenStore } from "@payroll-qa/adapters";
import { getPlatformConnection, recordPlatformConnectionError, savePlatformConnection } from "@payroll-qa/db";
import { db } from "./db";
import { env } from "./env";
import { decrypt, encrypt } from "./crypto";

export const gustoRedirectUri = () => `${env.baseUrl}/auth/gusto/callback`;

export function gustoOAuthConfig(): GustoOAuthConfig | undefined {
  const o = env.gustoOAuth();
  return o ? { clientId: o.clientId, clientSecret: o.clientSecret, apiBase: o.apiBase } : undefined;
}

export function gustoTokenStore(): TokenStore {
  const secret = env.appSecret;
  return {
    async load() {
      const row = await getPlatformConnection(db(), "gusto");
      if (!row) return null;
      return { accessToken: decrypt(row.accessTokenEnc, secret), refreshToken: decrypt(row.refreshTokenEnc, secret), expiresAt: row.expiresAt, scope: row.scope ?? undefined };
    },
    async save(t) {
      await savePlatformConnection(db(), { platform: "gusto", accessTokenEnc: encrypt(t.accessToken, secret), refreshTokenEnc: encrypt(t.refreshToken, secret), expiresAt: t.expiresAt, scope: t.scope, refreshed: true });
    },
  };
}

let provider: (() => Promise<string>) | undefined;

/** The adapter for the firm's connection, or undefined when neither an OAuth app nor a static token is configured. */
export async function gustoAdapter(): Promise<GustoAdapter | undefined> {
  const oauth = gustoOAuthConfig();
  if (oauth && (await getPlatformConnection(db(), "gusto"))) {
    provider ??= gustoTokenProvider(oauth, gustoTokenStore(), gustoRedirectUri());
    const guarded = async () => {
      try {
        return await provider!();
      } catch (err) {
        await recordPlatformConnectionError(db(), "gusto", err instanceof Error ? err.message : String(err));
        throw err;
      }
    };
    return new GustoAdapter({ accessToken: guarded, apiBase: oauth.apiBase, apiVersion: env.gustoApiVersion() });
  }
  const s = env.gusto();
  return s ? new GustoAdapter(s) : undefined;
}
