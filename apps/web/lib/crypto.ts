/** AES-256-GCM at rest for platform tokens, keyed from APP_SECRET. Output: base64url(iv).base64url(ciphertext).base64url(tag). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = (secret: string) => createHash("sha256").update(`payroll-qa-tokens:${secret}`).digest();

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function decrypt(blob: string, secret: string): string {
  const [iv, ct, tag] = blob.split(".");
  if (!iv || !ct || !tag) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
