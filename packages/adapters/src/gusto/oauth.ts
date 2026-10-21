/**
 * Gusto accountant-partner OAuth. The firm's payroll admin authorizes the app
 * once; the access token lives two hours and the refresh token rotates on
 * every use, so the rotated pair must be persisted before any request that
 * triggered the refresh proceeds. Nothing here writes to Gusto.
 */
export interface GustoOAuthConfig {
  clientId: string;
  clientSecret: string;
  apiBase?: string; // https://api.gusto.com or https://api.gusto-demo.com
  fetchImpl?: typeof fetch;
}

export interface GustoTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the access token. */
  expiresAt: Date;
  scope?: string;
}

const base = (c: GustoOAuthConfig) => (c.apiBase ?? "https://api.gusto.com").replace(/\/$/, "");

export function gustoAuthorizeUrl(cfg: GustoOAuthConfig, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code", state });
  return `${base(cfg)}/oauth/authorize?${p}`;
}

async function tokenRequest(cfg: GustoOAuthConfig, body: Record<string, string>, now: Date): Promise<GustoTokens> {
  const res = await (cfg.fetchImpl ?? fetch)(`${base(cfg)}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
  });
  if (!res.ok) throw new Error(`Gusto token endpoint ${res.status}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token) throw new Error("Gusto token endpoint returned no token pair");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(now.getTime() + (json.expires_in ?? 7200) * 1000), scope: json.scope };
}

export function gustoExchangeCode(cfg: GustoOAuthConfig, code: string, redirectUri: string, now: Date = new Date()): Promise<GustoTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, now);
}

export function gustoRefresh(cfg: GustoOAuthConfig, refreshToken: string, redirectUri: string, now: Date = new Date()): Promise<GustoTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: redirectUri }, now);
}

export interface TokenStore {
  load(): Promise<GustoTokens | null>;
  /** Must complete before the caller proceeds: a rotated refresh token that is not persisted kills the connection. */
  save(tokens: GustoTokens): Promise<void>;
}

/**
 * A token provider for GustoAdapter: returns a valid access token, refreshing
 * five minutes before expiry and persisting the rotated pair before returning.
 * Concurrent callers share one refresh.
 */
export function gustoTokenProvider(cfg: GustoOAuthConfig, store: TokenStore, redirectUri: string, now: () => Date = () => new Date()): () => Promise<string> {
  let inflight: Promise<string> | undefined;
  return () => {
    inflight ??= (async () => {
      try {
        const current = await store.load();
        if (!current) throw new Error("Gusto is not connected; a payroll lead must authorize the app under Admin");
        if (current.expiresAt.getTime() - 5 * 60_000 > now().getTime()) return current.accessToken;
        const fresh = await gustoRefresh(cfg, current.refreshToken, redirectUri, now());
        await store.save(fresh);
        return fresh.accessToken;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}
