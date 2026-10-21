/**
 * Box document store. Service account scoped to payroll client folders only.
 * Authenticates with Client Credentials Grant: the token lives 60 minutes,
 * no refresh token is issued, so it is re-requested with a 5-minute margin.
 * Read scopes plus upload to the client folders; never delete.
 */
import type { DocumentStore } from "../index";

export interface BoxCcgConfig {
  clientId: string;
  clientSecret: string;
  /** Enterprise id for box_subject_type=enterprise, or a user id with subjectType "user". */
  subjectId: string;
  subjectType?: "enterprise" | "user";
}

export type TokenProvider = () => Promise<string>;

/** A token provider that caches the CCG token and re-requests it 5 minutes before expiry. */
export function boxCcgTokenProvider(cfg: BoxCcgConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      box_subject_type: cfg.subjectType ?? "enterprise",
      box_subject_id: cfg.subjectId,
    });
    const res = await fetchImpl("https://api.box.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new Error(`Box token ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: now() + json.expires_in * 1000 };
    return cached.token;
  };
}

export class BoxStore implements DocumentStore {
  private tokenProvider: TokenProvider;
  constructor(tokenOrProvider: string | TokenProvider, private fetchImpl: typeof fetch = fetch) {
    this.tokenProvider = typeof tokenOrProvider === "string" ? async () => tokenOrProvider : tokenOrProvider;
  }

  private async headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${await this.tokenProvider()}`, ...extra };
  }

  async put(clientFolderId: string, name: string, bytes: Uint8Array, mime: string): Promise<string> {
    const form = () => {
      const f = new FormData();
      f.append("attributes", JSON.stringify({ name, parent: { id: clientFolderId } }));
      f.append("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }), name);
      return f;
    };
    let res = await this.fetchImpl("https://upload.box.com/api/2.0/files/content", { method: "POST", headers: await this.headers(), body: form() });
    if (res.status === 409) {
      // name exists: upload a new version (Box keeps the prior version; nothing is deleted)
      const existing = await this.list(clientFolderId);
      const hit = existing.find((f) => f.name === name);
      if (!hit) throw new Error(`Box 409 on ${name} but file not found`);
      res = await this.fetchImpl(`https://upload.box.com/api/2.0/files/${hit.id}/content`, { method: "POST", headers: await this.headers(), body: form() });
    }
    if (!res.ok) throw new Error(`Box upload ${res.status}`);
    const json = (await res.json()) as { entries: { id: string }[] };
    return json.entries[0]!.id;
  }

  async list(folderId: string) {
    const out: { id: string; name: string; mime: string; size: number; type?: "file" | "folder" }[] = [];
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(`https://api.box.com/2.0/folders/${folderId}/items?fields=id,name,size,type,extension&limit=1000&offset=${offset}`, { headers: await this.headers() });
      if (!res.ok) throw new Error(`Box list ${res.status}`);
      const json = (await res.json()) as { entries: { id: string; name: string; size?: number; type: string; extension?: string }[]; total_count: number };
      for (const e of json.entries) if (e.type === "file" || e.type === "folder") out.push({ id: e.id, name: e.name, size: e.size ?? 0, mime: e.extension ?? "", type: e.type });
      offset += json.entries.length;
      if (offset >= json.total_count || json.entries.length === 0) break;
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(fileId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`https://api.box.com/2.0/files/${fileId}/content`, { headers: await this.headers() });
    if (!res.ok) throw new Error(`Box download ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Resolve "a/b/c.csv" under a folder by walking subfolders by name; null when any segment is missing. */
  async findByPath(folderId: string, relativePath: string): Promise<string | null> {
    const parts = relativePath.split("/").filter(Boolean);
    let current = folderId;
    for (let i = 0; i < parts.length; i++) {
      const items = await this.list(current);
      const last = i === parts.length - 1;
      const hit = items.find((x) => x.name === parts[i] && (last ? x.type === "file" : x.type === "folder"));
      if (!hit) return null;
      current = hit.id;
    }
    return current;
  }

  /** Text of a file at a relative path, or null when absent (the Rippling export watcher). */
  async readTextByPath(folderId: string, relativePath: string): Promise<string | null> {
    const id = await this.findByPath(folderId, relativePath);
    if (!id) return null;
    return new TextDecoder("utf-8").decode(await this.get(id));
  }
}
