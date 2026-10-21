/**
 * Box document store. Service account scoped to payroll client folders only.
 * Requires BOX_ACCESS_TOKEN (or a JWT app config exchanged for one by the jobs app).
 */
import type { DocumentStore } from "../index.js";

export class BoxStore implements DocumentStore {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async put(clientFolderId: string, name: string, bytes: Uint8Array, mime: string): Promise<string> {
    const form = new FormData();
    form.append("attributes", JSON.stringify({ name, parent: { id: clientFolderId } }));
    form.append("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }), name);
    let res = await this.fetchImpl("https://upload.box.com/api/2.0/files/content", { method: "POST", headers: this.headers(), body: form });
    if (res.status === 409) {
      // name exists: upload a new version
      const existing = await this.list(clientFolderId);
      const hit = existing.find((f) => f.name === name);
      if (!hit) throw new Error(`Box 409 on ${name} but file not found`);
      res = await this.fetchImpl(`https://upload.box.com/api/2.0/files/${hit.id}/content`, { method: "POST", headers: this.headers(), body: form });
    }
    if (!res.ok) throw new Error(`Box upload ${res.status}`);
    const json = (await res.json()) as { entries: { id: string }[] };
    return json.entries[0]!.id;
  }

  async list(clientFolderId: string) {
    const out: { id: string; name: string; mime: string; size: number }[] = [];
    let offset = 0;
    for (;;) {
      const res = await this.fetchImpl(`https://api.box.com/2.0/folders/${clientFolderId}/items?fields=id,name,size,type,extension&limit=1000&offset=${offset}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`Box list ${res.status}`);
      const json = (await res.json()) as { entries: { id: string; name: string; size?: number; type: string; extension?: string }[]; total_count: number };
      for (const e of json.entries) if (e.type === "file") out.push({ id: e.id, name: e.name, size: e.size ?? 0, mime: e.extension ?? "" });
      offset += json.entries.length;
      if (offset >= json.total_count || json.entries.length === 0) break;
    }
    return out;
  }

  async get(fileId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`https://api.box.com/2.0/files/${fileId}/content`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Box download ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
