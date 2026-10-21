/**
 * C3: a minister the profile marks FICA-exempt shows zero Social Security
 * and Medicare on both sides, and federal withholding only under a voluntary
 * election. A non-minister with wages and no FICA at all is set up as exempt
 * on the platform without the profile saying so, and is raised for review.
 */
import type { Check, Exception } from "../types";
import { dollars } from "../context";

export const C3: Check = {
  code: "C3",
  family: "C",
  title: "Minister FICA exemption and voluntary withholding",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const t = d.taxes;
      const fica = t.socialSecurityEmployeeCents + t.medicareEmployeeCents + t.socialSecurityEmployerCents + t.medicareEmployerCents;
      if (!p.isMinister) {
        if (fica === 0 && d.grossCents > 0) {
          out.push({
            checkCode: "C3",
            severity: "review",
            employeeId: p.id,
            employeeName: p.name,
            expected: "Social Security and Medicare withheld (not a minister on the profile)",
            actual: `no FICA on gross ${dollars(d.grossCents)}`,
            sourceOfExpected: "profile",
            description: "Platform withholds no FICA from an employee the profile does not mark exempt.",
          });
        }
        continue;
      }
      if (p.ficaExempt && fica !== 0) {
        out.push({
          checkCode: "C3",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "zero Social Security and Medicare (minister, FICA exempt)",
          actual: `FICA withheld or contributed ${dollars(fica)}`,
          sourceOfExpected: "profile",
          description: "Platform is withholding FICA from a minister the profile marks exempt.",
        });
      }
      if (!p.fedWithholdingVoluntary && t.federalWithholdingCents !== 0) {
        out.push({
          checkCode: "C3",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "no federal withholding (no voluntary election on the profile)",
          actual: `federal withholding ${dollars(t.federalWithholdingCents)}`,
          sourceOfExpected: "profile",
          description: "Federal withholding present for a minister with no voluntary withholding election.",
        });
      }
    }
    return out;
  },
};
