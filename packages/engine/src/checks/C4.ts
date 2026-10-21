/**
 * C4: the housing allowance earning type is excluded from taxable wages. The
 * platform setting is a block when it reads taxable; when the platform does
 * not report it, the specialist's confirmation on the signed profile stands
 * in, and without either the setup is raised for review.
 */
import type { Check, Exception } from "../types.js";
import { dollars, earning } from "../context.js";

export const C4: Check = {
  code: "C4",
  family: "C",
  title: "Housing allowance earning type excluded from taxable wages",
  severity: "block",
  run(ctx) {
    const anyHousing = ctx.draft.employees.some((e) => earning(e, "housing_allowance") > 0);
    if (!anyHousing) return [];
    const out: Exception[] = [];
    if (ctx.draft.platformHousingEarningExcluded === false) {
      out.push({
        checkCode: "C4",
        severity: "block",
        expected: "housing_allowance earning type excluded from taxable wages",
        actual: "earning type configured as taxable",
        sourceOfExpected: "platform_rule",
        description: "Platform earning type for housing allowance is not set to exclude from income.",
      });
    } else if (ctx.draft.platformHousingEarningExcluded === undefined && !ctx.profile.housingEarningTypeConfirmedExcluded) {
      out.push({
        checkCode: "C4",
        severity: "review",
        expected: "housing_allowance earning type confirmed excluded from taxable wages",
        actual: "platform does not report the setting and the profile carries no confirmation",
        sourceOfExpected: "platform_rule",
        description: "Confirm in the platform that the housing earning type is excluded from taxable wages and record it on the profile.",
      });
    }
    for (const e of ctx.draft.employees) {
      for (const line of e.earnings) {
        if (line.type === "housing_allowance" && line.amountCents > 0 && line.excludedFromTaxableWages === false) {
          const p = ctx.profileByPlatformId.get(e.platformEmployeeId);
          out.push({
            checkCode: "C4",
            severity: "block",
            employeeId: p?.id,
            employeeName: p?.name ?? e.name,
            expected: "housing line excluded from taxable wages",
            actual: `housing ${dollars(line.amountCents)} taxable`,
            sourceOfExpected: "platform_rule",
            description: "Housing allowance line is flagged taxable on the draft.",
          });
        }
      }
    }
    return out;
  },
};
