/**
 * Apply pending migrations at deploy time. Loud about what it does:
 *   - DATABASE_URL unset: skip with a notice and exit 0, so a deployment can be
 *     built before the database exists (the app then reports the database as
 *     unconfigured at /api/health until the variable is set and redeployed);
 *   - set: apply drizzle's migrations folder inside a transaction, print each
 *     step, and fail the build on any error so a broken schema never ships.
 */
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] DATABASE_URL is not set; skipping migrations. Set it in the Vercel project and redeploy to create the schema.");
  process.exit(0);
}

const folder = fileURLToPath(new URL("../migrations", import.meta.url));
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, onnotice: () => {} });
try {
  const started = Date.now();
  console.log(`[migrate] applying migrations from ${folder}`);
  await migrate(drizzle(sql), { migrationsFolder: folder });
  const [{ count }] = await sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`;
  console.log(`[migrate] done in ${Date.now() - started} ms; ${count} migration(s) recorded`);
} catch (err) {
  console.error("[migrate] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
