import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Postgres connection for Vercel functions: small pool, no prepared statements (pgBouncer/Neon pooling). */
export function createDb(url: string): Db {
  const sql = postgres(url, { max: 4, prepare: false, idle_timeout: 20 });
  return drizzle(sql, { schema });
}
