import { createDb, type Db } from "@payroll-qa/db";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __payrollQaDb: Db | undefined;
}

/** One connection pool per process; Next.js dev reloads would otherwise open a pool per reload. */
export function db(): Db {
  if (!globalThis.__payrollQaDb) globalThis.__payrollQaDb = createDb(env.databaseUrl);
  return globalThis.__payrollQaDb;
}
