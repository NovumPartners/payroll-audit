import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../src/schema";
import { replaceDraftProfile, signProfile, upsertClient, upsertUser, type AnyDb } from "../src/repo";
import { profile as fixtureProfile } from "../../engine/test/fixtures";

export async function testDb(): Promise<AnyDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return db as unknown as AnyDb;
}

/** Seed the Grace Fellowship fixture: a lead, a specialist, the client, and its profile (optionally signed). */
export async function seedGrace(db: AnyDb, opts: { sign?: boolean } = {}) {
  const lead = await upsertUser(db, { email: "lead@novumsp.com", name: "Pod Lead", role: "lead" });
  const specialist = await upsertUser(db, { email: "specialist@novumsp.com", name: "Payroll Specialist", role: "specialist", slackUserId: "U123" });
  const client = await upsertClient(db, {
    legalName: "Grace Fellowship (fixture)",
    platform: "gusto",
    platformCompanyId: "co_grace",
    payFrequency: "semimonthly",
    cutoffDaysBeforePayDate: 2,
    boxFolderId: "box_grace",
    specialistId: specialist.id,
    contactName: "Church Admin",
    contactEmail: "admin@gracefellowship.example",
    status: "onboarding",
    clergyPresent: true,
    registeredStates: ["TX"],
  });
  const p = fixtureProfile();
  await replaceDraftProfile(db, client.id, {
    employees: p.employees.map(({ id: _id, ...e }) => e),
    housingAllowances: p.housingAllowances.map((h) => ({ ...h, platformEmployeeId: pid(p, h.employeeId) })),
    benefitElections: p.benefitElections.map((b) => ({ ...b, platformEmployeeId: pid(p, b.employeeId) })),
    timeOffPolicies: p.timeOffPolicies.map((t) => ({ ...t, assignedPlatformEmployeeIds: t.assignedEmployeeIds.map((id) => pid(p, id)) })),
    questions: [],
  });
  if (opts.sign !== false) await signProfile(db, { clientId: client.id, userId: specialist.id, at: new Date("2026-10-20T15:00:00Z"), housingEarningTypeConfirmedExcluded: true });
  return { lead, specialist, client };
}

function pid(p: ReturnType<typeof fixtureProfile>, employeeId: string): string {
  const e = p.employees.find((x) => x.id === employeeId);
  if (!e) throw new Error(`fixture employee ${employeeId} missing`);
  return e.platformEmployeeId;
}
