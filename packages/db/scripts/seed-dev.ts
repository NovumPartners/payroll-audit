/**
 * Development seed: two people and the Grace Fellowship fixture client with a
 * signed profile. Refuses to run against production. Idempotent.
 *   DATABASE_URL=postgres://... pnpm --filter @payroll-qa/db seed:dev
 */
import { createDb } from "../src/client";
import { replaceDraftProfile, signProfile, upsertClient, upsertUser, getClient } from "../src/repo";
import { profile as fixtureProfile } from "../../engine/test/fixtures";

if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  console.error("seed-dev refuses to run in production");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const lead = await upsertUser(db, { email: process.env.SEED_LEAD_EMAIL ?? "lead@novumsp.com", name: "Pod Lead", role: "lead", slackUserId: "U_LEAD" });
const specialist = await upsertUser(db, { email: process.env.SEED_SPECIALIST_EMAIL ?? "specialist@novumsp.com", name: "Payroll Specialist", role: "specialist", slackUserId: "U_SPEC" });
await upsertUser(db, { email: "reviewer@novumsp.com", name: "Reviewer", role: "reviewer" });
const client = await upsertClient(db, {
  legalName: "Grace Fellowship (fixture)",
  platform: "gusto",
  platformCompanyId: "co_grace",
  payFrequency: "semimonthly",
  cutoffDaysBeforePayDate: 2,
  cutoffHourUtc: 22,
  specialistId: specialist.id,
  contactName: "Church Admin",
  contactEmail: "admin@gracefellowship.example",
  status: "onboarding",
  clergyPresent: true,
  registeredStates: ["TX"],
});
const existing = await getClient(db, client.id);
if (!existing?.profileSignedAt) {
  const p = fixtureProfile();
  const pid = (id: string) => p.employees.find((e) => e.id === id)!.platformEmployeeId;
  await replaceDraftProfile(db, client.id, {
    employees: p.employees.map(({ id: _id, ...e }) => e),
    housingAllowances: p.housingAllowances.map((h) => ({ ...h, platformEmployeeId: pid(h.employeeId) })),
    benefitElections: p.benefitElections.map((b) => ({ ...b, platformEmployeeId: pid(b.employeeId) })),
    timeOffPolicies: p.timeOffPolicies.map((t) => ({ ...t, assignedPlatformEmployeeIds: t.assignedEmployeeIds.map(pid) })),
    questions: [],
  });
  await signProfile(db, { clientId: client.id, userId: specialist.id, housingEarningTypeConfirmedExcluded: true });
}
console.log(JSON.stringify({ lead: lead.email, specialist: specialist.email, clientId: client.id }));
process.exit(0);
