import { beforeEach, describe, expect, it } from "vitest";
import { runChecks, type PayrollProfile } from "@payroll-qa/engine";
import { base, draft as fixtureDraft, prior as fixturePrior, emp } from "../../engine/test/fixtures";
import {
  admitEntraUser,
  applyChangeRequest,
  decideException,
  ensureRun,
  getChangeRequest,
  insertChangeRequest,
  latestExceptions,
  listQueue,
  loadLedger,
  loadProfile,
  markSubmitted,
  persistQaAttempt,
  recordClientApproval,
  recordSubmittedComparison,
  rejectChangeRequest,
  replaceDraftProfile,
  signGate,
  signProfile,
  type AnyDb,
} from "../src/repo";
import * as s from "../src/schema";
import { eq } from "drizzle-orm";
import { seedGrace, testDb } from "./helpers";

/** Remap the in-memory fixture onto the database's employee ids so the engine fixtures can be reused. */
function withDbIds(p: PayrollProfile) {
  const ids = new Map(p.employees.map((e) => [e.platformEmployeeId, e.id]));
  const id = (platformId: string) => ids.get(platformId)!;
  return { id, ids };
}

let db: AnyDb;
let seeded: Awaited<ReturnType<typeof seedGrace>>;
let profile: PayrollProfile;
let id: (platformId: string) => string;

beforeEach(async () => {
  db = await testDb();
  seeded = await seedGrace(db);
  profile = (await loadProfile(db, seeded.client.id))!;
  ({ id } = withDbIds(profile));
});

describe("profile", () => {
  it("round-trips the fixture profile and the engine passes a clean run against it", async () => {
    expect(profile.signedAt).toBe("2026-10-20T15:00:00.000Z");
    expect(profile.employees.map((e) => e.platformEmployeeId).sort()).toEqual(["g_1001", "g_1002", "g_1003"]);
    expect(profile.housingAllowances[0]).toMatchObject({ employeeId: id("g_1001"), perPeriodAmountCents: 150000, resolutionDate: "2025-12-10" });
    expect(profile.benefitElections.map((b) => b.planId).sort()).toEqual(["403b", "med_ppo"]);
    expect(profile.timeOffPolicies[0]).toMatchObject({ accrualRateHours: 4, capHours: 120 });
    expect(profile.timeOffPolicies[0]!.assignedEmployeeIds.sort()).toEqual([id("g_1002"), id("g_1003")].sort());
    expect(profile.housingEarningTypeConfirmedExcluded).toBe(true);
    const r = runChecks({ profile, ledger: [], draft: fixtureDraft(), prior: fixturePrior(), asOf: "2026-11-18" });
    expect(r.exceptions).toEqual([]);
  });

  it("refuses a re-draft once signed; the sign gate holds a minister without a resolution and an open question", async () => {
    await expect(replaceDraftProfile(db, seeded.client.id, { employees: [], housingAllowances: [], benefitElections: [], timeOffPolicies: [], questions: [] })).rejects.toThrow(/signed/);
    const fresh = await testDb();
    const unsigned = await seedGrace(fresh, { sign: false });
    expect((await signGate(fresh, unsigned.client.id)).ok).toBe(true);
    await fresh.delete(s.housingAllowances);
    await fresh.insert(s.profileQuestions).values({ clientId: unsigned.client.id, field: "hire_date", question: "When was Tom hired?" });
    const gate = await signGate(fresh, unsigned.client.id);
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toEqual(["1 profile question unresolved", "Pastor Daniel Reyes: minister with no housing resolution on file"]);
    await expect(signProfile(fresh, { clientId: unsigned.client.id, userId: unsigned.specialist.id })).rejects.toThrow(/cannot be signed/);
  });

  it("signature moves an onboarding client to live and is logged", async () => {
    const [c] = await db.select().from(s.clients).where(eq(s.clients.id, seeded.client.id));
    expect(c!.status).toBe("live");
    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "profile.signed"));
    expect(log).toHaveLength(1);
    expect(log[0]!.userId).toBe(seeded.specialist.id);
  });
});

describe("ledger", () => {
  const rateChange = (sub: string) => ({
    clientId: seeded.client.id,
    employeeId: id("g_1002"),
    type: "rate_change" as const,
    effectiveDate: "2026-11-01",
    status: "received" as const,
    submittedBy: "admin@gracefellowship.example",
    submittedAt: "2026-10-28T15:00:00Z",
    jotformSubmissionId: sub,
    payload: { kind: "rate_change" as const, newRateCents: 6300000 },
  });

  it("is idempotent on the JotForm submission id", async () => {
    const a = await insertChangeRequest(db, rateChange("9001"));
    const b = await insertChangeRequest(db, rateChange("9001"));
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(await loadLedger(db, seeded.client.id)).toHaveLength(1);
  });

  it("applying a rate change captures the previous rate and moves the profile; a second apply is refused", async () => {
    const { id: reqId } = await insertChangeRequest(db, rateChange("9002"));
    await applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id, at: new Date("2026-10-29T10:00:00Z") });
    const cr = (await getChangeRequest(db, reqId!))!;
    expect(cr.status).toBe("applied_to_profile");
    expect(cr.payload).toEqual({ kind: "rate_change", newRateCents: 6300000, previousRateCents: 6000000 });
    const p = (await loadProfile(db, seeded.client.id))!;
    expect(p.employees.find((e) => e.platformEmployeeId === "g_1002")).toMatchObject({ rateCents: 6300000, rateEffectiveDate: "2026-11-01" });
    await expect(applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id })).rejects.toThrow(/not received/);
    // the engine now has what it needs to prorate from the request alone
    const r = runChecks({ profile: p, ledger: [cr], draft: fixtureDraft(), prior: fixturePrior(), asOf: "2026-11-18" });
    expect(r.exceptions.map((e) => e.checkCode)).toContain("A1"); // draft still at the old rate
  });

  it("a housing change closes the prior designation the day before and opens the new one", async () => {
    const { id: reqId } = await insertChangeRequest(db, { ...rateChange("9003"), employeeId: id("g_1001"), type: "housing_change", effectiveDate: "2027-01-01", payload: { kind: "housing_change", annualAmountCents: 4800000, perPeriodAmountCents: 200000, resolutionDate: "2026-12-10" } });
    await applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id, extras: { resolutionDocBoxFileId: "box_res_2027" } });
    const rows = await db.select().from(s.housingAllowances).where(eq(s.housingAllowances.employeeId, id("g_1001"))).orderBy(s.housingAllowances.effectiveFrom);
    expect(rows.map((h) => [h.effectiveFrom, h.effectiveTo, h.perPeriodAmountCents])).toEqual([
      ["2026-01-01", "2026-12-31", 150000],
      ["2027-01-01", null, 200000],
    ]);
    expect(rows[1]!.resolutionDocBoxFileId).toBe("box_res_2027");
  });

  it("housing cannot be applied to a non-minister", async () => {
    const { id: reqId } = await insertChangeRequest(db, { ...rateChange("9004"), type: "housing_change", payload: { kind: "housing_change", annualAmountCents: 1, perPeriodAmountCents: 1, resolutionDate: "2026-12-10" } });
    await expect(applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id })).rejects.toThrow(/minister/);
  });

  it("a new hire needs the platform id and work state at apply time, then exists on the profile", async () => {
    const { id: reqId } = await insertChangeRequest(db, { ...rateChange("9005"), employeeId: undefined, type: "new_hire", effectiveDate: "2026-11-09", payload: { kind: "new_hire", payType: "hourly", rateCents: 2000, hireDate: "2026-11-09", name: "Ana Price" } });
    await expect(applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id })).rejects.toThrow(/platform employee id/);
    await applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id, extras: { platformEmployeeId: "g_1004", workState: "tx", standardHours: 80 } });
    const p = (await loadProfile(db, seeded.client.id))!;
    expect(p.employees.find((e) => e.platformEmployeeId === "g_1004")).toMatchObject({ name: "Ana Price", workState: "TX", hireDate: "2026-11-09", rateCents: 2000, standardHours: 80 });
    expect((await getChangeRequest(db, reqId!))!.employeeId).toBe(p.employees.find((e) => e.platformEmployeeId === "g_1004")!.id);
  });

  it("termination marks the employee; a benefit change to a new plan needs the plan's name and treatment", async () => {
    const t = await insertChangeRequest(db, { ...rateChange("9006"), employeeId: id("g_1003"), type: "termination", effectiveDate: "2026-11-10", payload: { kind: "termination", terminationDate: "2026-11-10", payoutAccruedTimeOff: true } });
    await applyChangeRequest(db, { requestId: t.id!, userId: seeded.specialist.id });
    expect((await loadProfile(db, seeded.client.id))!.employees.find((e) => e.platformEmployeeId === "g_1003")).toMatchObject({ status: "terminated", terminationDate: "2026-11-10" });
    const b = await insertChangeRequest(db, { ...rateChange("9007"), type: "benefit_change", payload: { kind: "benefit_change", planId: "dental", employeeDeductionCents: 3000, employerContributionCents: 0 } });
    await expect(applyChangeRequest(db, { requestId: b.id!, userId: seeded.specialist.id })).rejects.toThrow(/name and tax treatment/);
    await applyChangeRequest(db, { requestId: b.id!, userId: seeded.specialist.id, extras: { planName: "Dental", preTax: true } });
    const p = (await loadProfile(db, seeded.client.id))!;
    expect(p.benefitElections.filter((e) => e.employeeId === id("g_1002")).map((e) => e.planId).sort()).toEqual(["403b", "dental", "med_ppo"]);
  });

  it("rejection needs a reason", async () => {
    const { id: reqId } = await insertChangeRequest(db, rateChange("9008"));
    await expect(rejectChangeRequest(db, { requestId: reqId!, userId: seeded.lead.id, reason: " " })).rejects.toThrow(/reason/);
    await rejectChangeRequest(db, { requestId: reqId!, userId: seeded.lead.id, reason: "Duplicate of 9002" });
    expect((await getChangeRequest(db, reqId!))!.status).toBe("rejected");
  });
});

describe("runs and exceptions", () => {
  const period = { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" };
  const cutoff = new Date("2026-11-18T22:00:00Z");

  async function qa(input = base(), at = new Date("2026-11-16T07:00:00Z")) {
    const run = await ensureRun(db, { clientId: seeded.client.id, period, cutoffAt: cutoff });
    const report = runChecks({ ...input, profile: (await loadProfile(db, seeded.client.id))!, ledger: await loadLedger(db, seeded.client.id) });
    const result = await persistQaAttempt(db, { runId: run.id, draft: input.draft, prior: input.prior ?? null, report, at });
    return { run, report, result };
  }

  it("ensureRun is idempotent per client and period", async () => {
    const a = await ensureRun(db, { clientId: seeded.client.id, period, cutoffAt: cutoff });
    const b = await ensureRun(db, { clientId: seeded.client.id, period, cutoffAt: cutoff, platformPayrollId: "pr_x" });
    expect(b.id).toBe(a.id);
    expect(b.platformPayrollId).toBe("pr_x");
  });

  it("persists a clean attempt as qa_passed with the snapshots stored whole", async () => {
    const { run, result } = await qa();
    expect(result).toEqual({ attempt: 1, status: "qa_passed", openBlock: 0, openReview: 0, exceptions: 0 });
    const [row] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, run.id));
    expect((row!.draftSnapshot as { platformPayrollId: string }).platformPayrollId).toBe("pr_2026_11_15");
    expect((row!.priorSnapshot as { platformPayrollId: string }).platformPayrollId).toBe("pr_2026_10_31");
    expect(row!.qaAttempt).toBe(1);
  });

  it("decisions need a note, are final, and carry forward across attempts the right way", async () => {
    const input = base();
    input.draft.blockers = [{ code: "bank", message: "unverified" }];
    emp(input.draft, "g_1003").hours = 100;
    emp(input.draft, "g_1003").earnings = [{ type: "regular", amountCents: 220000, hours: 100 }];
    emp(input.draft, "g_1003").grossCents = 220000;
    const first = await qa(input);
    expect(first.result).toMatchObject({ attempt: 1, status: "qa_exceptions", openBlock: 1, openReview: 1 });
    const ex = await latestExceptions(db, first.run.id);
    const d1 = ex.find((e) => e.checkCode === "D1")!;
    const b3 = ex.find((e) => e.checkCode === "B3")!;
    await expect(decideException(db, { exceptionId: d1.id, userId: seeded.specialist.id, status: "cleared", note: "" })).rejects.toThrow(/note/);
    await decideException(db, { exceptionId: d1.id, userId: seeded.specialist.id, status: "cleared", note: "Bank verified in Gusto 11/16" });
    await decideException(db, { exceptionId: b3.id, userId: seeded.specialist.id, status: "documented", note: "Approved overtime for the retreat week" });
    await expect(decideException(db, { exceptionId: d1.id, userId: seeded.specialist.id, status: "documented", note: "x" })).rejects.toThrow(/already/);

    // re-run with the blocker still present: cleared reopens with the prior note; documented stays documented
    const second = await qa(input, new Date("2026-11-16T09:00:00Z"));
    expect(second.result).toMatchObject({ attempt: 2, status: "qa_exceptions", openBlock: 1, openReview: 0 });
    const ex2 = await latestExceptions(db, second.run.id);
    expect(ex2.find((e) => e.checkCode === "D1")).toMatchObject({ status: "open", recurrenceOfId: d1.id, priorNote: "Cleared on attempt 1 (Bank verified in Gusto 11/16); the finding is back" });
    expect(ex2.find((e) => e.checkCode === "B3")).toMatchObject({ status: "documented", clearanceNote: "Approved overtime for the retreat week", recurrenceOfId: b3.id });
    // attempt 1 rows are kept untouched
    expect(await latestExceptions(db, first.run.id, 1)).toHaveLength(2);

    // the correction takes: blocker gone, run passes with the documented review carried
    input.draft.blockers = [];
    const third = await qa(input, new Date("2026-11-16T11:00:00Z"));
    expect(third.result).toMatchObject({ attempt: 3, status: "qa_passed", openBlock: 0, openReview: 0, exceptions: 1 });
  });

  it("a finding cleared last period that recurs reopens with the prior note attached", async () => {
    const priorPeriod = { start: "2026-10-16", end: "2026-10-31", payDate: "2026-11-05" };
    const priorRun = await ensureRun(db, { clientId: seeded.client.id, period: priorPeriod, cutoffAt: new Date("2026-11-03T22:00:00Z") });
    const input = base();
    input.draft.period = priorPeriod;
    input.draft.blockers = [{ code: "bank", message: "unverified" }];
    const report = runChecks({ ...input, profile, prior: undefined });
    await persistQaAttempt(db, { runId: priorRun.id, draft: input.draft, prior: null, report, at: new Date("2026-11-01T07:00:00Z") });
    const [old] = await latestExceptions(db, priorRun.id);
    await decideException(db, { exceptionId: old!.id, userId: seeded.specialist.id, status: "cleared", note: "Bank letter uploaded" });
    const again = base();
    again.draft.blockers = [{ code: "bank", message: "unverified" }];
    const { run } = await qa(again);
    const [e] = await latestExceptions(db, run.id);
    expect(e).toMatchObject({ status: "open", recurrenceOfId: old!.id, priorNote: "cleared last period: Bank letter uploaded" });
  });

  it("client approval is refused while a block is open, accepted once documented, refused after cutoff by link; submission needs approval", async () => {
    const input = base();
    input.draft.blockers = [{ code: "bank", message: "unverified" }];
    const { run } = await qa(input);
    await expect(recordClientApproval(db, { runId: run.id, approvedBy: "admin@gracefellowship.example", method: "link", at: new Date("2026-11-17T12:00:00Z") })).rejects.toThrow(/1 block exception still open/);
    await expect(markSubmitted(db, { runId: run.id, userId: seeded.specialist.id })).rejects.toThrow(/approval is required/);
    const [e] = await latestExceptions(db, run.id);
    await decideException(db, { exceptionId: e!.id, userId: seeded.specialist.id, status: "documented", note: "Bank verification pending; Gusto confirmed it will not delay the run" });
    await expect(recordClientApproval(db, { runId: run.id, approvedBy: "admin@gracefellowship.example", method: "link", at: new Date("2026-11-18T22:00:01Z") })).rejects.toThrow(/expired/);
    await recordClientApproval(db, { runId: run.id, approvedBy: "admin@gracefellowship.example", method: "link", at: new Date("2026-11-17T12:00:00Z") });
    await expect(recordClientApproval(db, { runId: run.id, approvedBy: "x", method: "reply" })).rejects.toThrow(/already approved/);
    // an applied request becomes verified_in_platform on submission
    const { id: reqId } = await insertChangeRequest(db, { clientId: seeded.client.id, employeeId: id("g_1002"), type: "one_time_pay", effectiveDate: "2026-11-01", status: "received", submittedBy: "a", submittedAt: "2026-10-28T15:00:00Z", jotformSubmissionId: "9100", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 1 } });
    await applyChangeRequest(db, { requestId: reqId!, userId: seeded.specialist.id });
    await markSubmitted(db, { runId: run.id, userId: seeded.specialist.id, at: new Date("2026-11-18T20:00:00Z") });
    expect((await getChangeRequest(db, reqId!))).toMatchObject({ status: "verified_in_platform" });
    await expect(persistQaAttempt(db, { runId: run.id, draft: input.draft, prior: null, report: runChecks({ ...input, profile }) })).rejects.toThrow(/submitted/);
    await recordSubmittedComparison(db, { runId: run.id, submitted: input.draft, diffs: [{ checkCode: "POST", employeeId: id("g_1002"), expected: "gross $2,500.00", actual: "gross $2,600.00", sourceOfExpected: "prior_run", description: "Submitted register differs from the approved draft." }] });
    const post = await db.select().from(s.exceptions).where(eq(s.exceptions.kind, "post_submit"));
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({ severity: "block", status: "open", employeeId: id("g_1002") });
    await expect(recordSubmittedComparison(db, { runId: run.id, submitted: input.draft, diffs: [] })).rejects.toThrow(/Already compared/);
  });

  it("the queue sorts by cutoff then open blocks and scopes to a specialist", async () => {
    const input = base();
    input.draft.blockers = [{ code: "a", message: "a" }, { code: "b", message: "b" }];
    const { run } = await qa(input);
    const other = await db.insert(s.clients).values({ legalName: "Another Church", platform: "gusto", platformCompanyId: "co_other", payFrequency: "biweekly", status: "live", registeredStates: ["TX"] }).returning();
    const earlier = await ensureRun(db, { clientId: other[0]!.id, period: { start: "2026-11-02", end: "2026-11-15", payDate: "2026-11-19" }, cutoffAt: new Date("2026-11-17T22:00:00Z") });
    const all = await listQueue(db, { asOf: new Date("2026-11-16T12:00:00Z") });
    expect(all.map((q) => [q.runId, q.openBlock, q.daysToCutoff])).toEqual([
      [earlier.id, 0, 2],
      [run.id, 2, 3],
    ]);
    expect(all[1]).toMatchObject({ clientName: "Grace Fellowship (fixture)", specialistName: "Payroll Specialist", status: "qa_exceptions" });
    const mine = await listQueue(db, { asOf: new Date("2026-11-16T12:00:00Z"), specialistId: seeded.specialist.id });
    expect(mine.map((q) => q.runId)).toEqual([run.id]);
  });
});

describe("access list", () => {
  it("admits an active listed email, binds the Entra id once, and refuses a different id later", async () => {
    expect(await admitEntraUser(db, "nobody@novumsp.com", "oid-1")).toBeNull();
    const u = await admitEntraUser(db, "Specialist@novumsp.com", "oid-1");
    expect(u?.role).toBe("specialist");
    expect((await admitEntraUser(db, "specialist@novumsp.com", "oid-1"))?.entraOid).toBe("oid-1");
    await expect(admitEntraUser(db, "specialist@novumsp.com", "oid-2")).rejects.toThrow(/identity/);
    await db.update(s.users).set({ active: false }).where(eq(s.users.email, "specialist@novumsp.com"));
    expect(await admitEntraUser(db, "specialist@novumsp.com", "oid-1")).toBeNull();
  });
});
