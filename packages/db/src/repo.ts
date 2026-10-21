/**
 * Repository: every read and write the jobs and the dashboard need, over a
 * drizzle Postgres database (postgres-js in production, pglite in tests).
 * The product controls live here as code: a run cannot be approved with an
 * open block; a profile with an active minister and no housing resolution
 * cannot be signed; a decision needs a note; nothing is deleted after a
 * profile is signed; QA attempts and their decisions are kept.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  BenefitElection,
  ChangePayload,
  ChangeRequest,
  DraftRun,
  Exception,
  HousingAllowance,
  PayrollProfile,
  ProfileEmployee,
  RunReport,
  TimeOffPolicy,
} from "@payroll-qa/engine";
import * as s from "./schema";

export type AnyDb = PgDatabase<PgQueryResultHKT, typeof s>;

export class RepoError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

// ---------- users ----------

export async function userByEmail(db: AnyDb, email: string) {
  const [u] = await db.select().from(s.users).where(eq(s.users.email, email.toLowerCase()));
  return u ?? null;
}

export async function userById(db: AnyDb, id: string) {
  const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
  return u ?? null;
}

/**
 * Admit a Microsoft work account: the email must be on the access list and
 * active; the first sign-in binds the Entra object id, and a later sign-in
 * with a different object id for the same email is refused.
 */
export async function admitEntraUser(db: AnyDb, email: string, entraOid: string) {
  const u = await userByEmail(db, email);
  if (!u || !u.active) return null;
  if (u.entraOid && u.entraOid !== entraOid) throw new RepoError("Account identity does not match the one first bound to this email", "identity_mismatch");
  if (!u.entraOid) await db.update(s.users).set({ entraOid, updatedAt: new Date() }).where(eq(s.users.id, u.id));
  return { ...u, entraOid };
}

export async function listUsers(db: AnyDb) {
  return db.select().from(s.users).orderBy(asc(s.users.name));
}

export async function upsertUser(db: AnyDb, row: { email: string; name: string; role: "lead" | "specialist" | "reviewer"; active?: boolean; slackUserId?: string | null }) {
  const email = row.email.toLowerCase();
  const [u] = await db
    .insert(s.users)
    .values({ email, name: row.name, role: row.role, active: row.active ?? true, slackUserId: row.slackUserId ?? null })
    .onConflictDoUpdate({ target: s.users.email, set: { name: row.name, role: row.role, active: row.active ?? true, slackUserId: row.slackUserId ?? null, updatedAt: new Date() } })
    .returning();
  return u!;
}

// ---------- clients ----------

export type ClientRow = typeof s.clients.$inferSelect;

export async function getClient(db: AnyDb, id: string): Promise<ClientRow | null> {
  const [c] = await db.select().from(s.clients).where(eq(s.clients.id, id));
  return c ?? null;
}

export async function clientByPlatformCompany(db: AnyDb, platform: "gusto" | "rippling", platformCompanyId: string) {
  const [c] = await db.select().from(s.clients).where(and(eq(s.clients.platform, platform), eq(s.clients.platformCompanyId, platformCompanyId)));
  return c ?? null;
}

export async function listClients(db: AnyDb, filter: { status?: ClientRow["status"]; specialistId?: string } = {}) {
  const conds = [];
  if (filter.status) conds.push(eq(s.clients.status, filter.status));
  if (filter.specialistId) conds.push(eq(s.clients.specialistId, filter.specialistId));
  return db.select().from(s.clients).where(conds.length ? and(...conds) : undefined).orderBy(asc(s.clients.legalName), asc(s.clients.id));
}

export async function upsertClient(db: AnyDb, row: Omit<typeof s.clients.$inferInsert, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
  const [c] = await db
    .insert(s.clients)
    .values(row)
    .onConflictDoUpdate({ target: [s.clients.platform, s.clients.platformCompanyId], set: { ...row, updatedAt: new Date() } })
    .returning();
  return c!;
}

// ---------- profile ----------

export async function loadProfile(db: AnyDb, clientId: string): Promise<PayrollProfile | null> {
  const client = await getClient(db, clientId);
  if (!client) return null;
  const emps = await db.select().from(s.employees).where(eq(s.employees.clientId, clientId)).orderBy(asc(s.employees.id));
  const empIds = emps.map((e) => e.id);
  const housing = empIds.length ? await db.select().from(s.housingAllowances).where(inArray(s.housingAllowances.employeeId, empIds)).orderBy(asc(s.housingAllowances.effectiveFrom), asc(s.housingAllowances.id)) : [];
  const elections = empIds.length
    ? await db
        .select({ el: s.benefitElections, plan: s.benefitPlans })
        .from(s.benefitElections)
        .innerJoin(s.benefitPlans, eq(s.benefitElections.planId, s.benefitPlans.id))
        .where(inArray(s.benefitElections.employeeId, empIds))
        .orderBy(asc(s.benefitElections.effectiveFrom), asc(s.benefitElections.id))
    : [];
  const policies = await db.select().from(s.timeOffPolicies).where(eq(s.timeOffPolicies.clientId, clientId)).orderBy(asc(s.timeOffPolicies.policyName));
  const employees: ProfileEmployee[] = emps.map((e) => ({
    id: e.id,
    platformEmployeeId: e.platformEmployeeId,
    name: e.name,
    status: e.status,
    hireDate: e.hireDate,
    terminationDate: e.terminationDate ?? undefined,
    payType: e.payType,
    rateCents: e.rateCents,
    rateEffectiveDate: e.rateEffectiveDate,
    standardHours: e.standardHours,
    workState: e.workState,
    isMinister: e.isMinister,
    ficaExempt: e.ficaExempt,
    fedWithholdingVoluntary: e.fedWithholdingVoluntary,
    anniversaryStepIncrease: e.anniversaryStepIncrease || undefined,
    benefitEligibilityDate: e.benefitEligibilityDate ?? undefined,
  }));
  const housingAllowances: HousingAllowance[] = housing.map((h) => ({
    employeeId: h.employeeId,
    annualAmountCents: h.annualAmountCents,
    perPeriodAmountCents: h.perPeriodAmountCents,
    resolutionDate: h.resolutionDate,
    resolutionDocId: h.resolutionDocBoxFileId ?? undefined,
    effectiveFrom: h.effectiveFrom,
    effectiveTo: h.effectiveTo ?? undefined,
  }));
  const benefitElections: BenefitElection[] = elections.map(({ el, plan }) => ({
    employeeId: el.employeeId,
    planId: plan.platformPlanId,
    planName: plan.name,
    employeeDeductionCents: el.employeeDeductionCents,
    employerContributionCents: el.employerContributionCents,
    preTax: plan.preTax,
    effectiveFrom: el.effectiveFrom,
    effectiveTo: el.effectiveTo ?? undefined,
  }));
  const timeOffPolicies: TimeOffPolicy[] = policies.map((p) => ({
    policyName: p.policyName,
    accrualRateHours: p.accrualRateHoursX100 / 100,
    accrualBasis: p.accrualBasis,
    capHours: p.capHours ?? undefined,
    assignedEmployeeIds: [...p.assignedEmployeeIds].sort(),
  }));
  return {
    clientId: client.id,
    clientName: client.legalName,
    platform: client.platform,
    payFrequency: client.payFrequency,
    signedBy: client.profileSignedBy ?? undefined,
    signedAt: iso(client.profileSignedAt),
    employees,
    housingAllowances,
    benefitElections,
    timeOffPolicies,
    registeredStates: [...client.registeredStates].sort(),
    housingEarningTypeConfirmedExcluded: client.housingEarningTypeConfirmedExcluded || undefined,
    expectedPayDateLagDays: client.expectedPayDateLagDays ?? undefined,
  };
}

export interface ProfileDraftInput {
  employees: Omit<ProfileEmployee, "id">[];
  housingAllowances: (Omit<HousingAllowance, "employeeId"> & { platformEmployeeId: string })[];
  benefitElections: (Omit<BenefitElection, "employeeId"> & { platformEmployeeId: string })[];
  timeOffPolicies: (Omit<TimeOffPolicy, "assignedEmployeeIds"> & { assignedPlatformEmployeeIds: string[] })[];
  questions: { platformEmployeeId?: string; field: string; platformValue?: string; documentValue?: string; sourceDocBoxFileId?: string; question: string }[];
}

/** Replace the unsigned draft profile for a client. Refused once the profile is signed: changes then arrive through the ledger. */
export async function replaceDraftProfile(db: AnyDb, clientId: string, draft: ProfileDraftInput) {
  const client = await getClient(db, clientId);
  if (!client) throw new RepoError("Client not found", "not_found");
  if (client.profileSignedAt) throw new RepoError("Profile is signed; changes arrive through change requests", "profile_signed");
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: s.employees.id }).from(s.employees).where(eq(s.employees.clientId, clientId));
    const ids = existing.map((e) => e.id);
    if (ids.length) {
      await tx.delete(s.profileQuestions).where(eq(s.profileQuestions.clientId, clientId));
      await tx.delete(s.housingAllowances).where(inArray(s.housingAllowances.employeeId, ids));
      await tx.delete(s.benefitElections).where(inArray(s.benefitElections.employeeId, ids));
    }
    await tx.delete(s.timeOffPolicies).where(eq(s.timeOffPolicies.clientId, clientId));
    await tx.delete(s.benefitPlans).where(eq(s.benefitPlans.clientId, clientId));
    // employees are upserted so ids referenced by change requests survive a re-draft
    const byPlatform = new Map<string, string>();
    for (const e of draft.employees) {
      const values = {
        platformEmployeeId: e.platformEmployeeId,
        name: e.name,
        status: e.status,
        hireDate: e.hireDate,
        terminationDate: e.terminationDate ?? null,
        payType: e.payType,
        rateCents: e.rateCents,
        rateEffectiveDate: e.rateEffectiveDate,
        standardHours: e.standardHours,
        workState: e.workState,
        isMinister: e.isMinister,
        ficaExempt: e.ficaExempt,
        fedWithholdingVoluntary: e.fedWithholdingVoluntary,
        anniversaryStepIncrease: e.anniversaryStepIncrease ?? false,
        benefitEligibilityDate: e.benefitEligibilityDate ?? null,
      };
      const [row] = await tx
        .insert(s.employees)
        .values({ clientId, ...values })
        .onConflictDoUpdate({ target: [s.employees.clientId, s.employees.platformEmployeeId], set: { ...values, updatedAt: new Date() } })
        .returning({ id: s.employees.id });
      byPlatform.set(e.platformEmployeeId, row!.id);
    }
    const empId = (pid: string) => {
      const id = byPlatform.get(pid);
      if (!id) throw new RepoError(`Draft references unknown platform employee ${pid}`, "invalid_draft");
      return id;
    };
    for (const h of draft.housingAllowances) {
      await tx.insert(s.housingAllowances).values({ employeeId: empId(h.platformEmployeeId), annualAmountCents: h.annualAmountCents, perPeriodAmountCents: h.perPeriodAmountCents, resolutionDate: h.resolutionDate, resolutionDocBoxFileId: h.resolutionDocId ?? null, effectiveFrom: h.effectiveFrom, effectiveTo: h.effectiveTo ?? null });
    }
    const plans = new Map<string, string>();
    for (const b of draft.benefitElections) {
      let planId = plans.get(b.planId);
      if (!planId) {
        const [p] = await tx.insert(s.benefitPlans).values({ clientId, platformPlanId: b.planId, name: b.planName, preTax: b.preTax }).returning({ id: s.benefitPlans.id });
        planId = p!.id;
        plans.set(b.planId, planId);
      }
      await tx.insert(s.benefitElections).values({ employeeId: empId(b.platformEmployeeId), planId, employeeDeductionCents: b.employeeDeductionCents, employerContributionCents: b.employerContributionCents, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo ?? null });
    }
    for (const p of draft.timeOffPolicies) {
      await tx.insert(s.timeOffPolicies).values({ clientId, policyName: p.policyName, accrualRateHoursX100: Math.round(p.accrualRateHours * 100), accrualBasis: p.accrualBasis, capHours: p.capHours ?? null, assignedEmployeeIds: p.assignedPlatformEmployeeIds.map(empId) });
    }
    for (const q of draft.questions) {
      await tx.insert(s.profileQuestions).values({ clientId, employeeId: q.platformEmployeeId ? empId(q.platformEmployeeId) : null, field: q.field, platformValue: q.platformValue ?? null, documentValue: q.documentValue ?? null, sourceDocBoxFileId: q.sourceDocBoxFileId ?? null, question: q.question });
    }
  });
}

export async function listQuestions(db: AnyDb, clientId: string) {
  return db.select().from(s.profileQuestions).where(eq(s.profileQuestions.clientId, clientId)).orderBy(asc(s.profileQuestions.createdAt), asc(s.profileQuestions.id));
}

/** Resolve a profile question. Known fields are written to the employee; every resolution is recorded with who and when. */
export async function resolveQuestion(db: AnyDb, args: { questionId: string; userId: string; resolution: "platform" | "document" | "corrected"; value?: string; at?: Date }) {
  const [q] = await db.select().from(s.profileQuestions).where(eq(s.profileQuestions.id, args.questionId));
  if (!q) throw new RepoError("Question not found", "not_found");
  const value = args.resolution === "platform" ? q.platformValue : args.resolution === "document" ? q.documentValue : args.value;
  if (args.resolution === "corrected" && (value === undefined || value === null || value === "")) throw new RepoError("A corrected value is required", "value_required");
  await db.transaction(async (tx) => {
    await tx.update(s.profileQuestions).set({ resolution: args.resolution, resolvedValue: value ?? null, resolvedBy: args.userId, resolvedAt: args.at ?? new Date(), updatedAt: new Date() }).where(eq(s.profileQuestions.id, q.id));
    if (q.employeeId && value) {
      const set = employeeFieldUpdate(q.field, value);
      if (set) await tx.update(s.employees).set({ ...set, updatedAt: new Date() }).where(eq(s.employees.id, q.employeeId));
    }
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "profile.question_resolved", clientId: q.clientId, targetId: q.id, detail: { field: q.field, resolution: args.resolution } });
  });
}

function employeeFieldUpdate(field: string, value: string): Partial<typeof s.employees.$inferInsert> | null {
  const yes = /^(yes|true|1|y)$/i.test(value);
  switch (field) {
    case "is_minister":
      return { isMinister: yes };
    case "fica_exempt":
      return { ficaExempt: yes };
    case "fed_withholding_voluntary":
      return { fedWithholdingVoluntary: yes };
    case "work_state":
      return { workState: value.toUpperCase() };
    case "hire_date":
      return { hireDate: value };
    case "rate_cents":
      return { rateCents: Number(value) };
    case "standard_hours":
      return { standardHours: Number(value) };
    default:
      return null;
  }
}

export interface SignGateResult {
  ok: boolean;
  reasons: string[];
}

/** The signature gate: no open question, and every active minister has a housing resolution on file. */
export async function signGate(db: AnyDb, clientId: string): Promise<SignGateResult> {
  const reasons: string[] = [];
  const open = await db.select({ n: sql<number>`count(*)::int` }).from(s.profileQuestions).where(and(eq(s.profileQuestions.clientId, clientId), isNull(s.profileQuestions.resolvedAt)));
  if ((open[0]?.n ?? 0) > 0) reasons.push(`${open[0]!.n} profile question${open[0]!.n === 1 ? "" : "s"} unresolved`);
  const ministers = await db.select().from(s.employees).where(and(eq(s.employees.clientId, clientId), eq(s.employees.isMinister, true), eq(s.employees.status, "active")));
  for (const m of ministers) {
    const [h] = await db.select().from(s.housingAllowances).where(and(eq(s.housingAllowances.employeeId, m.id), or(isNull(s.housingAllowances.effectiveTo), gte(s.housingAllowances.effectiveTo, sql`current_date`))));
    if (!h) reasons.push(`${m.name}: minister with no housing resolution on file`);
  }
  const emps = await db.select({ n: sql<number>`count(*)::int` }).from(s.employees).where(eq(s.employees.clientId, clientId));
  if ((emps[0]?.n ?? 0) === 0) reasons.push("no employees on the profile");
  return { ok: reasons.length === 0, reasons };
}

export async function signProfile(db: AnyDb, args: { clientId: string; userId: string; at?: Date; housingEarningTypeConfirmedExcluded?: boolean; pdfBoxFileId?: string }) {
  const gate = await signGate(db, args.clientId);
  if (!gate.ok) throw new RepoError(`Profile cannot be signed: ${gate.reasons.join("; ")}`, "sign_gate");
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(s.clients)
      .set({
        profileSignedBy: args.userId,
        profileSignedAt: at,
        housingEarningTypeConfirmedExcluded: args.housingEarningTypeConfirmedExcluded ?? false,
        profilePdfBoxFileId: args.pdfBoxFileId ?? null,
        status: sql`case when ${s.clients.status} = 'onboarding' then 'live'::client_status else ${s.clients.status} end`,
        updatedAt: at,
      })
      .where(eq(s.clients.id, args.clientId));
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "profile.signed", clientId: args.clientId, targetId: args.clientId, detail: { at: at.toISOString() } });
  });
}

export async function setProfilePdf(db: AnyDb, clientId: string, pdfBoxFileId: string) {
  await db.update(s.clients).set({ profilePdfBoxFileId: pdfBoxFileId, updatedAt: new Date() }).where(eq(s.clients.id, clientId));
}

// ---------- ledger ----------

function toChangeRequest(r: typeof s.changeRequests.$inferSelect): ChangeRequest {
  return {
    id: r.id,
    clientId: r.clientId,
    employeeId: r.employeeId ?? undefined,
    type: r.type,
    effectiveDate: r.effectiveDate,
    status: r.status,
    submittedBy: r.submittedBy,
    submittedAt: r.submittedAt.toISOString(),
    jotformSubmissionId: r.jotformSubmissionId ?? undefined,
    payload: r.payload as ChangePayload,
  };
}

export async function loadLedger(db: AnyDb, clientId: string): Promise<ChangeRequest[]> {
  const rows = await db.select().from(s.changeRequests).where(eq(s.changeRequests.clientId, clientId)).orderBy(asc(s.changeRequests.effectiveDate), asc(s.changeRequests.id));
  return rows.map(toChangeRequest);
}

export async function getChangeRequest(db: AnyDb, id: string) {
  const [r] = await db.select().from(s.changeRequests).where(eq(s.changeRequests.id, id));
  return r ? toChangeRequest(r) : null;
}

/** Insert a request from the webhook. Idempotent on the JotForm submission id: a duplicate delivery inserts nothing. */
export async function insertChangeRequest(db: AnyDb, cr: Omit<ChangeRequest, "id">): Promise<{ inserted: boolean; id?: string }> {
  const rows = await db
    .insert(s.changeRequests)
    .values({
      clientId: cr.clientId,
      employeeId: cr.employeeId ?? null,
      type: cr.type,
      payload: cr.payload,
      effectiveDate: cr.effectiveDate,
      submittedBy: cr.submittedBy,
      submittedAt: new Date(cr.submittedAt),
      jotformSubmissionId: cr.jotformSubmissionId ?? null,
      status: cr.status,
    })
    .onConflictDoNothing({ target: s.changeRequests.jotformSubmissionId })
    .returning({ id: s.changeRequests.id });
  return rows.length ? { inserted: true, id: rows[0]!.id } : { inserted: false };
}

export interface ApplyExtras {
  /** new_hire: the platform employee id once the person exists on the platform, plus profile facts the form does not carry */
  platformEmployeeId?: string;
  name?: string;
  workState?: string;
  isMinister?: boolean;
  ficaExempt?: boolean;
  fedWithholdingVoluntary?: boolean;
  standardHours?: number;
  /** benefit_change: plan name and tax treatment when the plan is new to the profile */
  planName?: string;
  preTax?: boolean;
  /** time_off_change: basis when the policy is new to the profile */
  accrualBasis?: "per_period" | "per_hour" | "annual_grant";
  /** housing_change: the Box file id of the resolution */
  resolutionDocBoxFileId?: string;
}

/**
 * Apply a received request to the profile. The one path that changes a signed
 * profile. Records previous values the engine needs (rate), closes the rows it
 * supersedes with an effective-to date rather than deleting them, and stamps
 * who applied it and when.
 */
export async function applyChangeRequest(db: AnyDb, args: { requestId: string; userId: string; at?: Date; extras?: ApplyExtras }) {
  const at = args.at ?? new Date();
  const x = args.extras ?? {};
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(s.changeRequests).where(eq(s.changeRequests.id, args.requestId)).for("update");
    if (!r) throw new RepoError("Request not found", "not_found");
    if (r.status !== "received") throw new RepoError(`Request is ${r.status}, not received`, "bad_status");
    let payload = r.payload as ChangePayload;
    let employeeId = r.employeeId;
    const employee = async () => {
      if (!employeeId) throw new RepoError("Request has no employee", "no_employee");
      const [e] = await tx.select().from(s.employees).where(eq(s.employees.id, employeeId)).for("update");
      if (!e) throw new RepoError("Employee not found", "not_found");
      return e;
    };
    switch (payload.kind) {
      case "new_hire": {
        if (!x.platformEmployeeId) throw new RepoError("The platform employee id is required to apply a new hire", "platform_id_required");
        if (!x.workState) throw new RepoError("The work state is required to apply a new hire", "work_state_required");
        const name = x.name ?? payload.name;
        if (!name) throw new RepoError("The employee name is required to apply a new hire", "name_required");
        const [e] = await tx
          .insert(s.employees)
          .values({
            clientId: r.clientId,
            platformEmployeeId: x.platformEmployeeId,
            name,
            status: "active",
            hireDate: payload.hireDate,
            payType: payload.payType,
            rateCents: payload.rateCents,
            rateEffectiveDate: payload.hireDate,
            standardHours: x.standardHours ?? 0,
            workState: x.workState.toUpperCase(),
            isMinister: x.isMinister ?? false,
            ficaExempt: x.ficaExempt ?? false,
            fedWithholdingVoluntary: x.fedWithholdingVoluntary ?? true,
          })
          .onConflictDoUpdate({
            target: [s.employees.clientId, s.employees.platformEmployeeId],
            set: { name, status: "active", hireDate: payload.hireDate, terminationDate: null, payType: payload.payType, rateCents: payload.rateCents, rateEffectiveDate: payload.hireDate, workState: x.workState.toUpperCase(), updatedAt: at },
          })
          .returning({ id: s.employees.id });
        employeeId = e!.id;
        break;
      }
      case "termination": {
        const e = await employee();
        await tx.update(s.employees).set({ status: "terminated", terminationDate: payload.terminationDate, updatedAt: at }).where(eq(s.employees.id, e.id));
        break;
      }
      case "rate_change": {
        const e = await employee();
        payload = { ...payload, previousRateCents: e.rateCents };
        await tx.update(s.employees).set({ rateCents: payload.newRateCents, rateEffectiveDate: r.effectiveDate, updatedAt: at }).where(eq(s.employees.id, e.id));
        break;
      }
      case "housing_change": {
        const e = await employee();
        if (!e.isMinister) throw new RepoError("Housing allowance can only be applied to an employee the profile designates as a minister", "not_minister");
        const dayBefore = new Date(Date.parse(r.effectiveDate) - 864e5).toISOString().slice(0, 10);
        await tx
          .update(s.housingAllowances)
          .set({ effectiveTo: dayBefore, updatedAt: at })
          .where(and(eq(s.housingAllowances.employeeId, e.id), or(isNull(s.housingAllowances.effectiveTo), gte(s.housingAllowances.effectiveTo, r.effectiveDate))));
        await tx.insert(s.housingAllowances).values({
          employeeId: e.id,
          annualAmountCents: payload.annualAmountCents,
          perPeriodAmountCents: payload.perPeriodAmountCents,
          resolutionDate: payload.resolutionDate,
          resolutionDocBoxFileId: x.resolutionDocBoxFileId ?? null,
          effectiveFrom: r.effectiveDate,
        });
        break;
      }
      case "benefit_change": {
        const e = await employee();
        let [plan] = await tx.select().from(s.benefitPlans).where(and(eq(s.benefitPlans.clientId, r.clientId), eq(s.benefitPlans.platformPlanId, payload.planId)));
        if (!plan) {
          if (!x.planName || x.preTax === undefined) throw new RepoError(`Plan ${payload.planId} is new to the profile; its name and tax treatment are required`, "plan_required");
          [plan] = await tx.insert(s.benefitPlans).values({ clientId: r.clientId, platformPlanId: payload.planId, name: x.planName, preTax: x.preTax }).returning();
        }
        const dayBefore = new Date(Date.parse(r.effectiveDate) - 864e5).toISOString().slice(0, 10);
        await tx
          .update(s.benefitElections)
          .set({ effectiveTo: dayBefore, updatedAt: at })
          .where(and(eq(s.benefitElections.employeeId, e.id), eq(s.benefitElections.planId, plan!.id), or(isNull(s.benefitElections.effectiveTo), gte(s.benefitElections.effectiveTo, r.effectiveDate))));
        if (payload.employeeDeductionCents !== 0 || payload.employerContributionCents !== 0) {
          await tx.insert(s.benefitElections).values({ employeeId: e.id, planId: plan!.id, employeeDeductionCents: payload.employeeDeductionCents, employerContributionCents: payload.employerContributionCents, effectiveFrom: r.effectiveDate });
        }
        break;
      }
      case "time_off_change": {
        const [pol] = await tx.select().from(s.timeOffPolicies).where(and(eq(s.timeOffPolicies.clientId, r.clientId), eq(s.timeOffPolicies.policyName, payload.policyName)));
        if (pol) {
          await tx.update(s.timeOffPolicies).set({ accrualRateHoursX100: Math.round(payload.accrualRateHours * 100), capHours: payload.capHours ?? null, updatedAt: at }).where(eq(s.timeOffPolicies.id, pol.id));
        } else {
          if (!x.accrualBasis) throw new RepoError(`Policy ${payload.policyName} is new to the profile; its accrual basis is required`, "basis_required");
          await tx.insert(s.timeOffPolicies).values({ clientId: r.clientId, policyName: payload.policyName, accrualRateHoursX100: Math.round(payload.accrualRateHours * 100), accrualBasis: x.accrualBasis, capHours: payload.capHours ?? null, assignedEmployeeIds: employeeId ? [employeeId] : [] });
        }
        break;
      }
      case "schedule_change":
        await tx.update(s.clients).set({ payFrequency: payload.payFrequency, updatedAt: at }).where(eq(s.clients.id, r.clientId));
        break;
      case "one_time_pay":
      case "deduction_change":
        break; // nothing on the profile changes; the engine verifies the draft against the request
    }
    await tx.update(s.changeRequests).set({ status: "applied_to_profile", payload, employeeId, appliedBy: args.userId, appliedAt: at, updatedAt: at }).where(eq(s.changeRequests.id, r.id));
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "change_request.applied", clientId: r.clientId, targetId: r.id, detail: { type: r.type, effectiveDate: r.effectiveDate } });
  });
}

export async function rejectChangeRequest(db: AnyDb, args: { requestId: string; userId: string; reason: string; at?: Date }) {
  if (!args.reason.trim()) throw new RepoError("A rejection reason is required", "reason_required");
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(s.changeRequests).where(eq(s.changeRequests.id, args.requestId));
    if (!r) throw new RepoError("Request not found", "not_found");
    if (r.status !== "received") throw new RepoError(`Request is ${r.status}, not received`, "bad_status");
    await tx.update(s.changeRequests).set({ status: "rejected", rejectionReason: args.reason, appliedBy: args.userId, appliedAt: at, updatedAt: at }).where(eq(s.changeRequests.id, r.id));
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "change_request.rejected", clientId: r.clientId, targetId: r.id, detail: { reason: args.reason } });
  });
}

// ---------- runs ----------

export type RunRow = typeof s.payrollRuns.$inferSelect;
export type ExceptionRow = typeof s.exceptions.$inferSelect;

export async function ensureRun(db: AnyDb, args: { clientId: string; period: { start: string; end: string; payDate: string }; cutoffAt: Date; platformPayrollId?: string }): Promise<RunRow> {
  const [row] = await db
    .insert(s.payrollRuns)
    .values({ clientId: args.clientId, periodStart: args.period.start, periodEnd: args.period.end, payDate: args.period.payDate, cutoffAt: args.cutoffAt, platformPayrollId: args.platformPayrollId ?? null })
    .onConflictDoUpdate({
      target: [s.payrollRuns.clientId, s.payrollRuns.periodStart, s.payrollRuns.periodEnd],
      set: { payDate: args.period.payDate, cutoffAt: args.cutoffAt, platformPayrollId: args.platformPayrollId ?? sql`${s.payrollRuns.platformPayrollId}`, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function getRun(db: AnyDb, runId: string): Promise<RunRow | null> {
  const [r] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId));
  return r ?? null;
}

export async function latestRunBefore(db: AnyDb, clientId: string, periodStart: string): Promise<RunRow | null> {
  const [r] = await db.select().from(s.payrollRuns).where(and(eq(s.payrollRuns.clientId, clientId), lt(s.payrollRuns.periodEnd, periodStart))).orderBy(desc(s.payrollRuns.periodEnd)).limit(1);
  return r ?? null;
}

export async function latestExceptions(db: AnyDb, runId: string, attempt?: number): Promise<ExceptionRow[]> {
  const run = await getRun(db, runId);
  if (!run) return [];
  const a = attempt ?? run.qaAttempt;
  return db
    .select()
    .from(s.exceptions)
    .where(and(eq(s.exceptions.runId, runId), eq(s.exceptions.attempt, a)))
    .orderBy(asc(s.exceptions.severity), asc(s.exceptions.checkCode), asc(s.exceptions.expected), asc(s.exceptions.actual), asc(s.exceptions.id));
}

const fingerprint = (e: { employeeId?: string | null; checkCode: string; expected: string; actual: string }) => `${e.employeeId ?? ""}|${e.checkCode}|${e.expected}|${e.actual}`;
const recurrenceKey = (e: { employeeId?: string | null; checkCode: string }) => `${e.employeeId ?? ""}|${e.checkCode}`;

/**
 * Persist a QA attempt: snapshots whole, the report, and one exception row per
 * finding. Decisions carry forward within the run (a documented finding that
 * re-fires identically stays documented; a cleared one that re-fires reopens
 * with the earlier note, because the correction did not take) and across
 * periods (a finding cleared last period that recurs reopens with the prior
 * note attached).
 */
export async function persistQaAttempt(db: AnyDb, args: { runId: string; draft: DraftRun; prior: DraftRun | null; report: RunReport; at?: Date; priorRunId?: string | null }) {
  const at = args.at ?? new Date();
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, args.runId)).for("update");
    if (!run) throw new RepoError("Run not found", "not_found");
    if (run.status === "submitted") throw new RepoError("Run is submitted; QA cannot be re-run", "submitted");
    const attempt = run.qaAttempt + 1;
    const previous = run.qaAttempt > 0 ? await tx.select().from(s.exceptions).where(and(eq(s.exceptions.runId, run.id), eq(s.exceptions.attempt, run.qaAttempt), eq(s.exceptions.kind, "qa"))) : [];
    const prevByFp = new Map(previous.map((e) => [fingerprint(e), e]));
    const priorRun = args.priorRunId ? await getRun(tx, args.priorRunId) : await latestRunBefore(tx, run.clientId, run.periodStart);
    const priorDecided = priorRun
      ? await tx.select().from(s.exceptions).where(and(eq(s.exceptions.runId, priorRun.id), eq(s.exceptions.attempt, priorRun.qaAttempt), ne(s.exceptions.status, "open")))
      : [];
    const priorByKey = new Map(priorDecided.map((e) => [recurrenceKey(e), e]));
    const employeeIds = new Set((await tx.select({ id: s.employees.id }).from(s.employees).where(eq(s.employees.clientId, run.clientId))).map((e) => e.id));

    let openBlock = 0;
    let openReview = 0;
    const rows: (typeof s.exceptions.$inferInsert)[] = [];
    for (const e of args.report.exceptions as Exception[]) {
      const employeeId = e.employeeId && employeeIds.has(e.employeeId) ? e.employeeId : null;
      const row: typeof s.exceptions.$inferInsert = {
        runId: run.id,
        attempt,
        kind: "qa",
        employeeId,
        checkCode: e.checkCode,
        severity: e.severity,
        expected: e.expected,
        actual: e.actual,
        sourceOfExpected: e.sourceOfExpected,
        description: e.description,
        requestId: e.requestId ?? null,
        status: "open",
      };
      const prev = prevByFp.get(fingerprint({ ...e, employeeId }));
      if (prev) {
        if (prev.status === "documented") {
          Object.assign(row, { status: "documented", clearedBy: prev.clearedBy, clearedAt: prev.clearedAt, clearanceNote: prev.clearanceNote, recurrenceOfId: prev.id });
        } else if (prev.status === "cleared") {
          Object.assign(row, { recurrenceOfId: prev.id, priorNote: `Cleared on attempt ${prev.attempt} (${prev.clearanceNote}); the finding is back` });
        } else {
          Object.assign(row, { recurrenceOfId: prev.recurrenceOfId ?? prev.id, priorNote: prev.priorNote });
        }
      } else {
        const recur = priorByKey.get(recurrenceKey({ ...e, employeeId }));
        if (recur) Object.assign(row, { recurrenceOfId: recur.id, priorNote: `${recur.status} last period: ${recur.clearanceNote}` });
      }
      if (row.status === "open" && e.severity === "block") openBlock++;
      if (row.status === "open" && e.severity === "review") openReview++;
      rows.push(row);
    }
    if (rows.length) await tx.insert(s.exceptions).values(rows);
    const status = openBlock + openReview === 0 ? "qa_passed" : "qa_exceptions";
    await tx
      .update(s.payrollRuns)
      .set({
        draftSnapshot: args.draft,
        priorSnapshot: args.prior,
        priorRunId: priorRun?.id ?? null,
        platformPayrollId: args.draft.platformPayrollId,
        qaReport: args.report,
        qaAttempt: attempt,
        qaRanAt: at,
        status,
        updatedAt: at,
      })
      .where(eq(s.payrollRuns.id, run.id));
    await tx.insert(s.runEvents).values({ runId: run.id, at, kind: "qa_run", detail: { attempt, counts: args.report.counts, openBlock, openReview } });
    return { attempt, status, openBlock, openReview, exceptions: rows.length };
  });
}

export async function setRunReportFile(db: AnyDb, runId: string, boxFileId: string) {
  await db.update(s.payrollRuns).set({ qaReportBoxFileId: boxFileId, updatedAt: new Date() }).where(eq(s.payrollRuns.id, runId));
}

export async function openCounts(db: AnyDb, runId: string): Promise<{ block: number; review: number; info: number }> {
  const run = await getRun(db, runId);
  if (!run) return { block: 0, review: 0, info: 0 };
  const rows = await db
    .select({ severity: s.exceptions.severity, n: sql<number>`count(*)::int` })
    .from(s.exceptions)
    .where(and(eq(s.exceptions.runId, runId), eq(s.exceptions.attempt, run.qaAttempt), eq(s.exceptions.status, "open")))
    .groupBy(s.exceptions.severity);
  const out = { block: 0, review: 0, info: 0 };
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

/** A decision on an exception. The note is mandatory; the decision is final for that row (a re-run makes new rows). */
export async function decideException(db: AnyDb, args: { exceptionId: string; userId: string; status: "cleared" | "documented"; note: string; at?: Date }) {
  if (!args.note.trim()) throw new RepoError("A note is required to clear or document an exception", "note_required");
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.exceptions).where(eq(s.exceptions.id, args.exceptionId)).for("update");
    if (!e) throw new RepoError("Exception not found", "not_found");
    if (e.status !== "open") throw new RepoError(`Exception is already ${e.status}`, "already_decided");
    const run = await getRun(tx, e.runId);
    if (run?.status === "submitted") throw new RepoError("Run is submitted", "submitted");
    await tx.update(s.exceptions).set({ status: args.status, clearedBy: args.userId, clearedAt: at, clearanceNote: args.note.trim(), updatedAt: at }).where(eq(s.exceptions.id, e.id));
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "exception.decided", clientId: run?.clientId ?? null, targetId: e.id, detail: { status: args.status, checkCode: e.checkCode } });
  });
}

/** Every read of a client's exceptions is logged with user and time (spec section 08). */
export async function logExceptionsRead(db: AnyDb, args: { runId: string; clientId: string; userId: string }) {
  await db.insert(s.auditLog).values({ userId: args.userId, action: "exceptions.read", clientId: args.clientId, targetId: args.runId });
}

export async function recordPreviewSent(db: AnyDb, args: { runId: string; userId: string; at?: Date; channel: string }) {
  const at = args.at ?? new Date();
  await db.update(s.payrollRuns).set({ previewSentAt: at, updatedAt: at }).where(eq(s.payrollRuns.id, args.runId));
  await db.insert(s.runEvents).values({ runId: args.runId, at, kind: "preview_sent", userId: args.userId, detail: { channel: args.channel } });
}

/** Client approval. Refused while any block exception from the latest attempt is open, and after the cutoff for a link approval. */
export async function recordClientApproval(db: AnyDb, args: { runId: string; approvedBy: string; method: "link" | "reply"; at?: Date; recordedByUserId?: string }) {
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, args.runId)).for("update");
    if (!run) throw new RepoError("Run not found", "not_found");
    if (run.status === "submitted") throw new RepoError("Run is already submitted", "submitted");
    if (run.status === "client_approved") throw new RepoError("Run is already approved", "already_approved");
    if (run.qaAttempt === 0) throw new RepoError("QA has not run", "no_qa");
    const counts = await openCounts(tx, run.id);
    if (counts.block > 0) throw new RepoError(`${counts.block} block exception${counts.block === 1 ? "" : "s"} still open`, "blocks_open");
    if (args.method === "link" && at > run.cutoffAt) throw new RepoError("The preview link expired at cutoff", "expired");
    await tx.update(s.payrollRuns).set({ status: "client_approved", clientApprovedBy: args.approvedBy, clientApprovedAt: at, clientApprovalMethod: args.method, updatedAt: at }).where(eq(s.payrollRuns.id, run.id));
    await tx.insert(s.runEvents).values({ runId: run.id, at, kind: "client_approved", userId: args.recordedByUserId ?? null, detail: { approvedBy: args.approvedBy, method: args.method } });
    await tx.insert(s.auditLog).values({ userId: args.recordedByUserId ?? null, action: "run.client_approved", clientId: run.clientId, targetId: run.id, detail: { approvedBy: args.approvedBy, method: args.method } });
  });
}

/** The specialist records that they submitted in the platform. Requires client approval. Applied requests up to the period end become verified_in_platform. */
export async function markSubmitted(db: AnyDb, args: { runId: string; userId: string; at?: Date }) {
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, args.runId)).for("update");
    if (!run) throw new RepoError("Run not found", "not_found");
    if (run.status !== "client_approved") throw new RepoError(`Run is ${run.status}; client approval is required before submission`, "not_approved");
    await tx.update(s.payrollRuns).set({ status: "submitted", submittedBy: args.userId, submittedAt: at, updatedAt: at }).where(eq(s.payrollRuns.id, run.id));
    await tx
      .update(s.changeRequests)
      .set({ status: "verified_in_platform", verifiedRunId: run.id, updatedAt: at })
      .where(and(eq(s.changeRequests.clientId, run.clientId), eq(s.changeRequests.status, "applied_to_profile"), sql`${s.changeRequests.effectiveDate} <= ${run.periodEnd}`));
    await tx.insert(s.runEvents).values({ runId: run.id, at, kind: "submitted", userId: args.userId });
    await tx.insert(s.auditLog).values({ userId: args.userId, action: "run.submitted", clientId: run.clientId, targetId: run.id });
  });
}

/** The morning-after comparison: store the processed register and open a post-submit exception per difference. */
export async function recordSubmittedComparison(db: AnyDb, args: { runId: string; submitted: DraftRun; diffs: Omit<Exception, "severity">[]; at?: Date }) {
  const at = args.at ?? new Date();
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, args.runId)).for("update");
    if (!run) throw new RepoError("Run not found", "not_found");
    if (run.status !== "submitted") throw new RepoError("Run is not submitted", "not_submitted");
    if (run.submittedComparedAt) throw new RepoError("Already compared", "already_compared");
    const employeeIds = new Set((await tx.select({ id: s.employees.id }).from(s.employees).where(eq(s.employees.clientId, run.clientId))).map((e) => e.id));
    if (args.diffs.length) {
      await tx.insert(s.exceptions).values(
        args.diffs.map((d) => ({
          runId: run.id,
          attempt: run.qaAttempt,
          kind: "post_submit" as const,
          employeeId: d.employeeId && employeeIds.has(d.employeeId) ? d.employeeId : null,
          checkCode: d.checkCode,
          severity: "block" as const,
          expected: d.expected,
          actual: d.actual,
          sourceOfExpected: d.sourceOfExpected,
          description: d.description,
          status: "open" as const,
        })),
      );
    }
    await tx.update(s.payrollRuns).set({ submittedSnapshot: args.submitted, submittedComparedAt: at, updatedAt: at }).where(eq(s.payrollRuns.id, run.id));
    await tx.insert(s.runEvents).values({ runId: run.id, at, kind: "post_submit_compared", detail: { differences: args.diffs.length } });
  });
}

export async function addRunEvent(db: AnyDb, args: { runId: string; kind: string; userId?: string; detail?: unknown; at?: Date }) {
  await db.insert(s.runEvents).values({ runId: args.runId, kind: args.kind, userId: args.userId ?? null, detail: args.detail ?? null, at: args.at ?? new Date() });
}

export async function hasRunEvent(db: AnyDb, runId: string, kind: string): Promise<boolean> {
  const [r] = await db.select({ id: s.runEvents.id }).from(s.runEvents).where(and(eq(s.runEvents.runId, runId), eq(s.runEvents.kind, kind))).limit(1);
  return !!r;
}

export async function listRunEvents(db: AnyDb, runId: string) {
  return db.select().from(s.runEvents).where(eq(s.runEvents.runId, runId)).orderBy(asc(s.runEvents.at), asc(s.runEvents.id));
}

export async function markLate(db: AnyDb, runId: string, at: Date) {
  await db.update(s.payrollRuns).set({ status: "late", updatedAt: at }).where(and(eq(s.payrollRuns.id, runId), ne(s.payrollRuns.status, "submitted")));
}

// ---------- queue ----------

export interface QueueRow {
  runId: string;
  clientId: string;
  clientName: string;
  specialistId: string | null;
  specialistName: string | null;
  payDate: string;
  cutoffAt: Date;
  daysToCutoff: number;
  status: RunRow["status"];
  openBlock: number;
  openReview: number;
  qaAttempt: number;
}

/** The exceptions queue: one screen for the pod, sorted by cutoff ascending then open blocks descending. */
export async function listQueue(db: AnyDb, args: { asOf: Date; specialistId?: string; includeSubmittedDays?: number }): Promise<QueueRow[]> {
  const since = new Date(args.asOf.getTime() - (args.includeSubmittedDays ?? 2) * 864e5);
  const runs = await db
    .select({ run: s.payrollRuns, client: s.clients, specialistName: s.users.name })
    .from(s.payrollRuns)
    .innerJoin(s.clients, eq(s.payrollRuns.clientId, s.clients.id))
    .leftJoin(s.users, eq(s.clients.specialistId, s.users.id))
    .where(and(or(ne(s.payrollRuns.status, "submitted"), gte(s.payrollRuns.submittedAt, since)), args.specialistId ? eq(s.clients.specialistId, args.specialistId) : undefined));
  if (runs.length === 0) return [];
  const counts = await db
    .select({ runId: s.exceptions.runId, attempt: s.exceptions.attempt, severity: s.exceptions.severity, n: sql<number>`count(*)::int` })
    .from(s.exceptions)
    .where(and(inArray(s.exceptions.runId, runs.map((r) => r.run.id)), eq(s.exceptions.status, "open")))
    .groupBy(s.exceptions.runId, s.exceptions.attempt, s.exceptions.severity);
  const out: QueueRow[] = runs.map(({ run, client, specialistName }) => {
    const mine = counts.filter((c) => c.runId === run.id && c.attempt === run.qaAttempt);
    return {
      runId: run.id,
      clientId: client.id,
      clientName: client.legalName,
      specialistId: client.specialistId,
      specialistName,
      payDate: run.payDate,
      cutoffAt: run.cutoffAt,
      daysToCutoff: Math.ceil((run.cutoffAt.getTime() - args.asOf.getTime()) / 864e5),
      status: run.status,
      openBlock: mine.find((c) => c.severity === "block")?.n ?? 0,
      openReview: mine.find((c) => c.severity === "review")?.n ?? 0,
      qaAttempt: run.qaAttempt,
    };
  });
  return out.sort((a, b) => a.cutoffAt.getTime() - b.cutoffAt.getTime() || b.openBlock - a.openBlock || a.clientName.localeCompare(b.clientName));
}

// ---------- notifications ----------

export async function recordNotification(db: AnyDb, n: { clientId?: string; runId?: string; audience: "specialist" | "lead" | "pod" | "client_contact_via_specialist"; recipient: string; kind: string; text: string }) {
  const [row] = await db.insert(s.notifications).values({ clientId: n.clientId ?? null, runId: n.runId ?? null, audience: n.audience, recipient: n.recipient, kind: n.kind, text: n.text }).returning();
  return row!;
}

export async function markNotification(db: AnyDb, id: string, result: { deliveredAt?: Date; error?: string }) {
  await db.update(s.notifications).set({ deliveredAt: result.deliveredAt ?? null, deliveryError: result.error ?? null }).where(eq(s.notifications.id, id));
}

export async function listNotifications(db: AnyDb, args: { clientId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(s.notifications)
    .where(args.clientId ? eq(s.notifications.clientId, args.clientId) : undefined)
    .orderBy(desc(s.notifications.createdAt), desc(s.notifications.id))
    .limit(args.limit ?? 200);
}

// ---------- audit ----------

export async function audit(db: AnyDb, entry: { userId?: string | null; action: string; clientId?: string | null; targetId?: string | null; detail?: unknown }) {
  await db.insert(s.auditLog).values({ userId: entry.userId ?? null, action: entry.action, clientId: entry.clientId ?? null, targetId: entry.targetId ?? null, detail: entry.detail ?? null });
}

export async function listAudit(db: AnyDb, args: { clientId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(s.auditLog)
    .where(args.clientId ? eq(s.auditLog.clientId, args.clientId) : undefined)
    .orderBy(desc(s.auditLog.at), desc(s.auditLog.id))
    .limit(args.limit ?? 200);
}

export { dateOnly };

/** Submitted runs not yet compared to their processed register, submitted before `before`. */
export async function runsAwaitingComparison(db: AnyDb, before: Date): Promise<RunRow[]> {
  return db
    .select()
    .from(s.payrollRuns)
    .where(and(eq(s.payrollRuns.status, "submitted"), isNull(s.payrollRuns.submittedComparedAt), lt(s.payrollRuns.submittedAt, before)))
    .orderBy(asc(s.payrollRuns.submittedAt), asc(s.payrollRuns.id));
}

/** Live clients with their specialist's Slack id, for the cycle. */
export async function listLiveClientsWithSpecialist(db: AnyDb) {
  return db
    .select({ client: s.clients, specialistSlack: s.users.slackUserId })
    .from(s.clients)
    .leftJoin(s.users, eq(s.clients.specialistId, s.users.id))
    .where(eq(s.clients.status, "live"))
    .orderBy(asc(s.clients.legalName), asc(s.clients.id));
}

/** The lead's Slack id (the first active lead with one), for escalations. */
export async function leadSlackId(db: AnyDb): Promise<string | undefined> {
  const [u] = await db.select({ slack: s.users.slackUserId }).from(s.users).where(and(eq(s.users.role, "lead"), eq(s.users.active, true), sql`${s.users.slackUserId} is not null`)).orderBy(asc(s.users.createdAt)).limit(1);
  return u?.slack ?? undefined;
}

// ---------- profile document facts ----------

export async function getDocumentFacts(db: AnyDb, clientId: string) {
  return db.select().from(s.profileDocumentFacts).where(eq(s.profileDocumentFacts.clientId, clientId)).orderBy(asc(s.profileDocumentFacts.boxFileId));
}

export async function saveDocumentFacts(db: AnyDb, row: { clientId: string; boxFileId: string; boxFileName: string; boxFileSha1: string; kind: string; facts: unknown; modelId?: string }) {
  await db
    .insert(s.profileDocumentFacts)
    .values({ clientId: row.clientId, boxFileId: row.boxFileId, boxFileName: row.boxFileName, boxFileSha1: row.boxFileSha1, kind: row.kind, facts: row.facts, modelId: row.modelId ?? null })
    .onConflictDoUpdate({ target: [s.profileDocumentFacts.clientId, s.profileDocumentFacts.boxFileId, s.profileDocumentFacts.boxFileSha1], set: { boxFileName: row.boxFileName, kind: row.kind, facts: row.facts, modelId: row.modelId ?? null, extractedAt: new Date() } });
}

// ---------- platform connections ----------

export type PlatformConnectionRow = typeof s.platformConnections.$inferSelect;

export async function getPlatformConnection(db: AnyDb, platform: "gusto" | "rippling"): Promise<PlatformConnectionRow | null> {
  const [r] = await db.select().from(s.platformConnections).where(eq(s.platformConnections.platform, platform));
  return r ?? null;
}

/** Store (or replace) the firm's connection. Called on first authorization and on every refresh, before the request that triggered it proceeds. */
export async function savePlatformConnection(db: AnyDb, row: { platform: "gusto" | "rippling"; accessTokenEnc: string; refreshTokenEnc: string; expiresAt: Date; scope?: string; connectedBy?: string; refreshed?: boolean; at?: Date }) {
  const at = row.at ?? new Date();
  await db
    .insert(s.platformConnections)
    .values({ platform: row.platform, accessTokenEnc: row.accessTokenEnc, refreshTokenEnc: row.refreshTokenEnc, expiresAt: row.expiresAt, scope: row.scope ?? null, connectedBy: row.connectedBy ?? null, connectedAt: at, lastRefreshedAt: row.refreshed ? at : null, lastError: null })
    .onConflictDoUpdate({
      target: s.platformConnections.platform,
      set: row.refreshed
        ? { accessTokenEnc: row.accessTokenEnc, refreshTokenEnc: row.refreshTokenEnc, expiresAt: row.expiresAt, scope: row.scope ?? null, lastRefreshedAt: at, lastError: null, updatedAt: at }
        : { accessTokenEnc: row.accessTokenEnc, refreshTokenEnc: row.refreshTokenEnc, expiresAt: row.expiresAt, scope: row.scope ?? null, connectedBy: row.connectedBy ?? null, connectedAt: at, lastRefreshedAt: null, lastError: null, updatedAt: at },
    });
}

export async function recordPlatformConnectionError(db: AnyDb, platform: "gusto" | "rippling", error: string) {
  await db.update(s.platformConnections).set({ lastError: error.slice(0, 500), updatedAt: new Date() }).where(eq(s.platformConnections.platform, platform));
}
