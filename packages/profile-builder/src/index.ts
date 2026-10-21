/**
 * Profile builder (spec section 07). Five steps:
 *   1. draft the profile tables mechanically from the platform pull;
 *   2. read the Box folder and extract every stated amount, date and policy,
 *      each tied to its source file (extract.ts, Claude with a JSON schema and
 *      excerpt verification);
 *   3. compare platform to documents; every disagreement is a question;
 *   4. flag every minister without a resolution, every housing line without a
 *      resolution, every employee with no benefit or PTO source document;
 *   5. write the draft and the questions for the specialist to resolve and sign
 *      (the dashboard; signature is `signProfile` in the repository).
 * Nothing here signs anything or writes to a signed profile.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DocumentStore, PlatformAdapter } from "@payroll-qa/adapters";
import type { DraftRun, PayrollProfile, ProfileEmployee } from "@payroll-qa/engine";
import { getDocumentFacts, replaceDraftProfile, saveDocumentFacts, type AnyDb, type ProfileDraftInput } from "@payroll-qa/db";
import { compareProfileToDocuments, type DocumentFact, type Question } from "./compare";
import { extractFacts } from "./extract";

export { compareProfileToDocuments, matchEmployee, type DocumentFact, type Question } from "./compare";
export { extractFacts, excerptPresent, toFacts, FACT_SCHEMA, EXTRACTION_MODEL } from "./extract";

export interface ProfileDraft {
  profile: PayrollProfile;
  questions: Question[];
}

/** Step 1: mechanical draft from the platform. Every minister-looking line becomes a question; nothing is assumed. */
export function draftFromPlatform(clientId: string, clientName: string, run: DraftRun, registeredStates: string[]): ProfileDraft {
  const questions: Question[] = [];
  const sorted = run.employees.slice().sort((a, b) => a.platformEmployeeId.localeCompare(b.platformEmployeeId));
  const employees: ProfileEmployee[] = sorted.map((e, i) => {
    const housing = e.earnings.find((l) => l.type === "housing_allowance");
    const fica = e.taxes.socialSecurityEmployeeCents + e.taxes.medicareEmployeeCents + e.taxes.socialSecurityEmployerCents + e.taxes.medicareEmployerCents;
    const looksMinister = !!housing || (fica === 0 && e.grossCents > 0);
    const id = `emp_${i + 1}`;
    if (looksMinister) {
      questions.push({ platformEmployeeId: e.platformEmployeeId, field: "is_minister", platformValue: housing ? `housing ${(housing.amountCents / 100).toFixed(2)} per period` : "no FICA withheld", question: `${e.name}: confirm minister status and attach the board housing resolution with the annual amount and date.` });
    }
    if (!e.workState) questions.push({ platformEmployeeId: e.platformEmployeeId, field: "work_state", question: `${e.name}: platform has no work location; confirm the work state.` });
    questions.push({ platformEmployeeId: e.platformEmployeeId, field: "hire_date", question: `${e.name}: hire date is not in the payroll pull; take it from the employee record or offer letter.` });
    return {
      id,
      platformEmployeeId: e.platformEmployeeId,
      name: e.name,
      status: "active",
      hireDate: "",
      payType: e.payType,
      rateCents: e.rateCents,
      rateEffectiveDate: run.period.start,
      standardHours: e.payType === "hourly" ? Math.round(e.standardHours ?? e.hours) : 0,
      workState: e.workState,
      isMinister: looksMinister,
      ficaExempt: looksMinister && fica === 0,
      fedWithholdingVoluntary: e.taxes.federalWithholdingCents > 0,
    };
  });
  const idOf = new Map(employees.map((e) => [e.platformEmployeeId, e.id]));
  const profile: PayrollProfile = {
    clientId,
    clientName,
    platform: run.platform,
    payFrequency: run.payFrequency,
    registeredStates,
    employees,
    housingAllowances: [],
    benefitElections: sorted.flatMap((e) =>
      e.deductions
        .filter((d) => d.planId)
        .map((d) => {
          if (d.preTax === undefined) {
            questions.push({ platformEmployeeId: e.platformEmployeeId, field: "benefit_pre_tax", platformValue: d.name, question: `${e.name}: the platform does not say whether ${d.name} is pre-tax; confirm from the plan summary.` });
          }
          return { employeeId: idOf.get(e.platformEmployeeId)!, planId: d.planId!, planName: d.name, employeeDeductionCents: d.employeeCents, employerContributionCents: d.employerCents, preTax: d.preTax ?? true, effectiveFrom: run.period.start };
        }),
    ),
    timeOffPolicies: Object.entries(run.platformAccruals ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, a]) => ({
        policyName: name,
        accrualRateHours: a.rateHours,
        accrualBasis: "per_period" as const,
        capHours: a.capHours,
        assignedEmployeeIds: employees.filter((x) => sorted.find((r) => r.platformEmployeeId === x.platformEmployeeId)?.timeOffBalanceHours !== undefined).map((x) => x.id),
      })),
  };
  return { profile, questions };
}

export interface BuildArgs {
  db: AnyDb;
  client: { id: string; name: string; platform: "gusto" | "rippling"; platformCompanyId: string; boxFolderId?: string; registeredStates: string[] };
  adapter: PlatformAdapter;
  docs: DocumentStore;
  /** Text of a Box file by id and name (PDF, docx, text); null when the type is not readable. */
  readDocumentText: (bytes: Uint8Array, name: string) => Promise<string | null>;
  anthropicApiKey?: string;
  now: Date;
  /** Injected for tests. */
  extract?: typeof extractFacts;
}

export interface BuildResult {
  employees: number;
  documents: number;
  facts: number;
  questions: number;
  housing: number;
  skipped: { name: string; reason: string }[];
}

const READABLE = /\.(pdf|docx|txt|md|csv)$/i;

/** Steps 1 to 5. Replaces the unsigned draft profile; refused by the repository once the profile is signed. */
export async function draftProfileForClient(a: BuildArgs): Promise<BuildResult> {
  const onOrAfter = new Date(a.now.getTime() - 45 * 864e5).toISOString().slice(0, 10);
  const run = (await a.adapter.pullDraft(a.client.platformCompanyId, onOrAfter)) ?? (await a.adapter.pullPrior(a.client.platformCompanyId, a.now.toISOString().slice(0, 10)));
  if (!run) throw new Error(`No payroll could be pulled from ${a.client.platform} for ${a.client.name}; the roster comes from the payroll, so the draft needs one.`);
  const step1 = draftFromPlatform(a.client.id, a.client.name, run, a.client.registeredStates);

  const skipped: BuildResult["skipped"] = [];
  const facts: DocumentFact[] = [];
  let documents = 0;
  if (a.client.boxFolderId) {
    const files = await listFilesRecursive(a.docs, a.client.boxFolderId, 2);
    const cached = await getDocumentFacts(a.db, a.client.id);
    const client = a.anthropicApiKey ? new Anthropic({ apiKey: a.anthropicApiKey }) : undefined;
    const extract = a.extract ?? extractFacts;
    for (const f of files) {
      if (!READABLE.test(f.name)) {
        skipped.push({ name: f.name, reason: "not a readable document type" });
        continue;
      }
      const hit = cached.find((c) => c.boxFileId === f.id && c.boxFileName === f.name && (c.boxFileSha1 ?? "") === String(f.size));
      if (hit) {
        facts.push(...(hit.facts as DocumentFact[]));
        documents++;
        continue;
      }
      if (!client) {
        skipped.push({ name: f.name, reason: "ANTHROPIC_API_KEY is not set; document extraction is off" });
        continue;
      }
      const bytes = await a.docs.get(f.id);
      const text = await a.readDocumentText(bytes, f.name);
      if (!text) {
        skipped.push({ name: f.name, reason: "no text could be read" });
        continue;
      }
      const result = await extract(client, { boxFileId: f.id, boxFileName: f.name }, text);
      await saveDocumentFacts(a.db, { clientId: a.client.id, boxFileId: f.id, boxFileName: f.name, boxFileSha1: String(f.size), kind: result.kind, facts: result.facts, modelId: result.modelId });
      facts.push(...result.facts);
      documents++;
    }
  }

  const { questions: compared, housing } = compareProfileToDocuments(step1.profile, facts);
  const questions = [...step1.questions, ...compared];
  // a hire date or work state the documents supply closes the matching step-1 question
  const answered = new Set(compared.filter((q) => q.field === "hire_date" || q.field === "work_state").map((q) => `${q.platformEmployeeId}|${q.field}`));
  const finalQuestions = questions.filter((q, i) => !(i < step1.questions.length && answered.has(`${q.platformEmployeeId}|${q.field}`)));

  const byId = new Map(step1.profile.employees.map((e) => [e.id, e.platformEmployeeId]));
  const draft: ProfileDraftInput = {
    employees: step1.profile.employees.map(({ id: _id, ...e }) => e),
    housingAllowances: housing,
    benefitElections: step1.profile.benefitElections.map(({ employeeId, ...b }) => ({ ...b, platformEmployeeId: byId.get(employeeId)! })),
    timeOffPolicies: step1.profile.timeOffPolicies.map(({ assignedEmployeeIds, ...t }) => ({ ...t, assignedPlatformEmployeeIds: assignedEmployeeIds.map((id) => byId.get(id)!) })),
    questions: finalQuestions,
  };
  await replaceDraftProfile(a.db, a.client.id, draft);
  return { employees: draft.employees.length, documents, facts: facts.length, questions: finalQuestions.length, housing: housing.length, skipped };
}

async function listFilesRecursive(docs: DocumentStore, folderId: string, depth: number): Promise<{ id: string; name: string; size: number }[]> {
  const items = await docs.list(folderId);
  const out: { id: string; name: string; size: number }[] = [];
  for (const it of items) {
    if (it.type === "folder") {
      if (depth > 0) out.push(...(await listFilesRecursive(docs, it.id, depth - 1)));
    } else out.push({ id: it.id, name: it.name, size: it.size });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}
