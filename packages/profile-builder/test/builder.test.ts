import { describe, expect, it } from "vitest";
import { compareProfileToDocuments, draftFromPlatform, excerptPresent, matchEmployee, toFacts, type DocumentFact } from "../src/index";
import { draft, profile } from "../../engine/test/fixtures";

const file = { boxFileId: "f1", boxFileName: "2025-12 Board Resolution Housing.pdf" };

describe("step 1: draft from platform", () => {
  it("drafts employees, elections and policies, and asks about every minister-looking line, hire date and unknown tax treatment", () => {
    const run = draft();
    run.employees[1]!.deductions[0]!.preTax = undefined;
    const d = draftFromPlatform("c1", "Grace", run, ["TX"]);
    expect(d.profile.employees.map((e) => [e.platformEmployeeId, e.isMinister, e.ficaExempt])).toEqual([["g_1001", true, true], ["g_1002", false, false], ["g_1003", false, false]]);
    expect(d.profile.benefitElections.map((b) => b.planId).sort()).toEqual(["403b", "med_ppo"]);
    expect(d.profile.timeOffPolicies[0]).toMatchObject({ policyName: "PTO Standard", accrualRateHours: 4, capHours: 120 });
    expect(d.questions.map((q) => q.field)).toEqual(["is_minister", "hire_date", "hire_date", "hire_date", "benefit_pre_tax"]);
    expect(d.profile.housingAllowances).toEqual([]); // never invented from a pay line
  });
});

describe("step 2: extraction post-processing", () => {
  const text = "RESOLVED, that Pastor Daniel Reyes is designated a housing allowance of $36,000 for calendar year 2026, payable $1,500.00 per pay period. Adopted December 10, 2025.";
  it("keeps only facts whose excerpt is in the document and normalizes types", () => {
    const { facts, dropped } = toFacts(
      {
        kind: "housing_resolution",
        facts: [
          { employeeName: "Pastor Daniel Reyes", annualHousingCents: 3600000, perPeriodHousingCents: 150000, resolutionDate: "2025-12-10", excerpt: "designated a housing allowance of $36,000" },
          { employeeName: "Someone Else", annualHousingCents: 1, excerpt: "words that are not in the document at all" },
          { employeeName: "X", annualHousingCents: 1.5, resolutionDate: "12/10/2025", excerpt: "Adopted December 10, 2025" },
        ],
      },
      file,
      text,
    );
    expect(dropped).toBe(1);
    expect(facts[0]).toEqual({ ...file, kind: "housing_resolution", excerpt: "designated a housing allowance of $36,000", employeeName: "Pastor Daniel Reyes", annualHousingCents: 3600000, perPeriodHousingCents: 150000, resolutionDate: "2025-12-10" });
    expect(facts[1]).toEqual({ ...file, kind: "housing_resolution", excerpt: "Adopted December 10, 2025", employeeName: "X" }); // non-integer cents and a US date are not facts
    expect(excerptPresent(text, "payable   $1,500.00  per pay period")).toBe(true);
    expect(excerptPresent(text, "short")).toBe(false);
  });
});

describe("steps 3 and 4: compare and flag", () => {
  const p = () => {
    const x = profile();
    x.housingAllowances = []; // the draft never has designations before documents are read
    return x;
  };
  const resolution: DocumentFact = { ...file, kind: "housing_resolution", employeeName: "Daniel Reyes", annualHousingCents: 3600000, perPeriodHousingCents: 150000, resolutionDate: "2025-12-10", effectiveFrom: "2026-01-01" };

  it("matches names exactly or by unique last name, never loosely", () => {
    const x = p();
    expect(matchEmployee(x, "Pastor Daniel Reyes")?.id).toBe("e_pastor");
    expect(matchEmployee(x, "Daniel Reyes")?.id).toBe("e_pastor");
    expect(matchEmployee(x, "Reyes")?.id).toBe("e_pastor");
    expect(matchEmployee(x, "Daniel")).toBeUndefined();
    x.employees.push({ ...x.employees[0]!, id: "e_other", platformEmployeeId: "g_9", name: "Ana Reyes" });
    expect(matchEmployee(x, "Reyes")).toBeUndefined();
  });

  it("a resolution becomes a housing designation tied to its file; a minister without one is flagged", () => {
    const r = compareProfileToDocuments(p(), [resolution]);
    expect(r.housing).toEqual([{ platformEmployeeId: "g_1001", annualAmountCents: 3600000, perPeriodAmountCents: 150000, resolutionDate: "2025-12-10", resolutionDocId: "f1", effectiveFrom: "2026-01-01", effectiveTo: undefined }]);
    expect(r.questions.map((q) => q.field)).toEqual(["benefit_source", "pto_source"]); // admin has deductions with no plan document; PTO policy has no document
    const none = compareProfileToDocuments(p(), []);
    expect(none.questions.find((q) => q.field === "housing_resolution")?.question).toContain("Pastor Daniel Reyes is a minister on the platform and no board housing resolution was found");
  });

  it("a resolution missing its per-period split or date asks rather than assumes", () => {
    const r = compareProfileToDocuments(p(), [{ ...resolution, perPeriodHousingCents: undefined }]);
    expect(r.housing[0]?.perPeriodAmountCents).toBe(0);
    expect(r.questions.find((q) => q.field === "housing_per_period")?.question).toContain("states no per-period split");
    const r2 = compareProfileToDocuments(p(), [{ ...resolution, resolutionDate: undefined }]);
    expect(r2.housing).toEqual([]);
    expect(r2.questions.find((q) => q.field === "housing_resolution")?.question).toContain("resolution date");
  });

  it("offer letter, benefit summary and PTO policy disagreements each become a question with both values and the source file", () => {
    const facts: DocumentFact[] = [
      resolution,
      { boxFileId: "f2", boxFileName: "Offer Letter Maria Soto.pdf", kind: "offer_letter", employeeName: "Maria Soto", rateCents: 6200000, hireDate: "2022-06-13", workState: "TX", payType: "salary" },
      { boxFileId: "f3", boxFileName: "Benefits 2026.pdf", kind: "benefit_summary", employeeName: "Maria Soto", planName: "Medical PPO", employeeDeductionCents: 18000, employerContributionCents: 40000, preTax: true },
      { boxFileId: "f3", boxFileName: "Benefits 2026.pdf", kind: "benefit_summary", employeeName: "Maria Soto", planName: "403(b)", employeeDeductionCents: 12500, employerContributionCents: 7500, preTax: true },
      { boxFileId: "f4", boxFileName: "PTO Policy.docx", kind: "pto_policy", policyName: "PTO Standard", accrualRateHours: 4, accrualBasis: "per_period", capHours: 160 },
      { boxFileId: "f5", boxFileName: "Old letter.pdf", kind: "offer_letter", employeeName: "Nobody Here", rateCents: 1 },
    ];
    const r = compareProfileToDocuments(p(), facts);
    expect(r.questions.map((q) => [q.field, q.platformValue, q.documentValue, q.sourceDocBoxFileId])).toEqual([
      ["rate_cents", "6000000", "6200000", "f2"],
      ["benefit_employer_contribution", "$420.00", "$400.00", "f3"],
      ["pto_cap", "120", "160", "f4"],
      ["unmatched_document", undefined, "Nobody Here", "f5"],
    ]);
  });

  it("a housing resolution for someone the platform does not treat as a minister raises the minister question", () => {
    const r = compareProfileToDocuments(p(), [{ ...resolution, employeeName: "Maria Soto" }]);
    expect(r.questions.find((q) => q.field === "is_minister")).toMatchObject({ platformEmployeeId: "g_1002", platformValue: "no", documentValue: "yes" });
  });
});
