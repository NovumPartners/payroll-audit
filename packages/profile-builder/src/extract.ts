/**
 * Step 2: extract every stated amount, date and policy from a document, as a
 * structured list of facts tied to the file. The model's output is constrained
 * to a JSON schema and every fact carries a verbatim excerpt; a fact whose
 * excerpt is not in the document text is dropped, never repaired.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DocumentFact } from "./compare";

export const EXTRACTION_MODEL = "claude-opus-5-5";

export const FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "facts"],
  properties: {
    kind: { type: "string", enum: ["housing_resolution", "benefit_summary", "offer_letter", "comp_memo", "pto_policy", "other"] },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["excerpt"],
        properties: {
          employeeName: { type: ["string", "null"] },
          annualHousingCents: { type: ["integer", "null"] },
          perPeriodHousingCents: { type: ["integer", "null"] },
          resolutionDate: { type: ["string", "null"], description: "ISO date YYYY-MM-DD" },
          effectiveFrom: { type: ["string", "null"] },
          effectiveTo: { type: ["string", "null"] },
          payType: { type: ["string", "null"], enum: ["salary", "hourly", null] },
          rateCents: { type: ["integer", "null"], description: "annual salary in cents, or hourly rate in cents" },
          rateEffectiveDate: { type: ["string", "null"] },
          hireDate: { type: ["string", "null"] },
          standardHours: { type: ["number", "null"] },
          workState: { type: ["string", "null"], description: "two-letter state" },
          isMinister: { type: ["boolean", "null"] },
          planName: { type: ["string", "null"] },
          employeeDeductionCents: { type: ["integer", "null"] },
          employerContributionCents: { type: ["integer", "null"] },
          preTax: { type: ["boolean", "null"] },
          policyName: { type: ["string", "null"] },
          accrualRateHours: { type: ["number", "null"] },
          accrualBasis: { type: ["string", "null"], enum: ["per_period", "per_hour", "annual_grant", null] },
          capHours: { type: ["number", "null"] },
          excerpt: { type: "string", description: "the exact words from the document that state this fact" },
        },
      },
    },
  },
} as const;

const SYSTEM = `You read documents from a church or nonprofit's payroll folder and list the facts they state, for a payroll specialist to compare against the payroll platform.

Rules:
- Report only what the document states. Never infer an amount, a date, or a classification that is not written.
- Every fact carries an excerpt: the exact words from the document that state it. If you cannot quote it, do not report it.
- Money is in integer cents. A per-period housing amount is reported only when the document states a per-period split.
- A housing allowance resolution is "housing_resolution" only when it is a board or governing body action designating an amount in advance. A letter that merely mentions housing is "other".
- Dates are ISO YYYY-MM-DD.
- One fact per employee per document is usual; a plan summary listing several employees produces one fact per employee.
- If the document is not about payroll (a lease, minutes about something else), set kind to "other" with an empty facts list.`;

export interface ExtractionResult {
  kind: DocumentFact["kind"];
  facts: DocumentFact[];
  modelId: string;
  dropped: number;
}

type Raw = { kind: DocumentFact["kind"]; facts: Record<string, unknown>[] };

/** Excerpt verification: whitespace-insensitive substring of the document text. */
export function excerptPresent(text: string, excerpt: string): boolean {
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const e = squash(excerpt);
  return e.length >= 8 && squash(text).includes(e);
}

export function toFacts(raw: Raw, file: { boxFileId: string; boxFileName: string }, text: string): { facts: DocumentFact[]; dropped: number } {
  const facts: DocumentFact[] = [];
  let dropped = 0;
  for (const r of raw.facts) {
    const excerpt = typeof r.excerpt === "string" ? r.excerpt : "";
    if (!excerptPresent(text, excerpt)) {
      dropped++;
      continue;
    }
    const f: DocumentFact = { boxFileId: file.boxFileId, boxFileName: file.boxFileName, kind: raw.kind, excerpt };
    const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
    const int = (k: string) => (typeof r[k] === "number" && Number.isInteger(r[k]) ? (r[k] as number) : undefined);
    const num = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : undefined);
    const bool = (k: string) => (typeof r[k] === "boolean" ? (r[k] as boolean) : undefined);
    const date = (k: string) => {
      const s = str(k);
      return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
    };
    Object.assign(f, {
      employeeName: str("employeeName"),
      annualHousingCents: int("annualHousingCents"),
      perPeriodHousingCents: int("perPeriodHousingCents"),
      resolutionDate: date("resolutionDate"),
      effectiveFrom: date("effectiveFrom"),
      effectiveTo: date("effectiveTo"),
      payType: str("payType") as DocumentFact["payType"],
      rateCents: int("rateCents"),
      rateEffectiveDate: date("rateEffectiveDate"),
      hireDate: date("hireDate"),
      standardHours: num("standardHours"),
      workState: str("workState")?.toUpperCase(),
      isMinister: bool("isMinister"),
      planName: str("planName"),
      employeeDeductionCents: int("employeeDeductionCents"),
      employerContributionCents: int("employerContributionCents"),
      preTax: bool("preTax"),
      policyName: str("policyName"),
      accrualRateHours: num("accrualRateHours"),
      accrualBasis: str("accrualBasis") as DocumentFact["accrualBasis"],
      capHours: num("capHours"),
    });
    for (const k of Object.keys(f) as (keyof DocumentFact)[]) if (f[k] === undefined) delete f[k];
    facts.push(f);
  }
  return { facts, dropped };
}

export async function extractFacts(client: Anthropic, file: { boxFileId: string; boxFileName: string }, text: string): Promise<ExtractionResult> {
  if (text.trim().length < 20) return { kind: "other", facts: [], modelId: EXTRACTION_MODEL, dropped: 0 };
  const response = await client.beta.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "high", format: { type: "json_schema", schema: FACT_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: `File name: ${file.boxFileName}\n\nDocument text:\n\n${text}` }],
  });
  if (response.stop_reason === "refusal") throw new Error(`Extraction refused for ${file.boxFileName}: ${response.stop_details?.explanation ?? "no explanation"}`);
  const raw = response.parsed_output as Raw | null;
  if (!raw) throw new Error(`Extraction for ${file.boxFileName} returned no parseable output`);
  const { facts, dropped } = toFacts(raw, file, text);
  return { kind: raw.kind, facts, modelId: response.model, dropped };
}
