/**
 * C2: housing allowance matches the board designation on the profile: the
 * per-period amount, the annual cap (when the platform reports year-to-date
 * housing), a housing line on a non-minister, and a designated minister paid
 * with no resolution on file. When year-to-date is not reported the cap is
 * stated as unverified rather than assumed fine.
 */
import type { Check, Exception } from "../types.js";
import { dollars, earning } from "../context.js";

export const C2: Check = {
  code: "C2",
  family: "C",
  title: "Housing allowance matches the designation",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    for (const p of ctx.profile.employees) {
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      const h = ctx.housingByEmployee.get(p.id);
      const housingLine = earning(d, "housing_allowance");
      const pendingHousing = ctx.ledgerInPeriod.find((c) => c.employeeId === p.id && c.payload.kind === "housing_change");
      if (pendingHousing) continue; // A1 verifies the change itself
      if (!p.isMinister && housingLine > 0) {
        out.push({
          checkCode: "C2",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "no housing allowance (not a minister on the profile)",
          actual: `housing ${dollars(housingLine)}`,
          sourceOfExpected: "profile",
          description: "Housing allowance paid to an employee the profile does not designate as a minister.",
        });
        continue;
      }
      if (p.isMinister && !h && housingLine > 0) {
        out.push({
          checkCode: "C2",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: "a board housing designation on the profile",
          actual: `housing ${dollars(housingLine)} with no designation`,
          sourceOfExpected: "profile",
          description: "Minister is paid a housing allowance but no resolution is on file.",
        });
        continue;
      }
      if (p.isMinister && h) {
        if (housingLine !== h.perPeriodAmountCents) {
          out.push({
            checkCode: "C2",
            severity: "block",
            employeeId: p.id,
            employeeName: p.name,
            expected: `housing ${dollars(h.perPeriodAmountCents)} per period (resolution ${h.resolutionDate})`,
            actual: housingLine === 0 ? "no housing line" : `housing ${dollars(housingLine)}`,
            sourceOfExpected: "profile",
            description: housingLine === 0 ? "Designated minister has no housing allowance line on the draft." : "Housing allowance per period does not match the designation.",
          });
        }
        if (d.ytdHousingCents === undefined) {
          if (housingLine > 0) {
            out.push({
              checkCode: "C2",
              severity: "info",
              employeeId: p.id,
              employeeName: p.name,
              expected: `year-to-date housing at or under ${dollars(h.annualAmountCents)}`,
              actual: "year-to-date housing not reported by the platform; annual cap not verified this run",
              sourceOfExpected: "profile",
              description: "The platform pull carries no year-to-date housing figure, so the annual designation cap was not tested.",
            });
          }
        } else {
          const ytd = d.ytdHousingCents + housingLine;
          if (ytd > h.annualAmountCents) {
            out.push({
              checkCode: "C2",
              severity: "block",
              employeeId: p.id,
              employeeName: p.name,
              expected: `year-to-date housing at or under ${dollars(h.annualAmountCents)}`,
              actual: `year-to-date housing ${dollars(ytd)} after this run`,
              sourceOfExpected: "profile",
              description: "This run would exceed the annual designated housing amount.",
            });
          }
        }
      }
    }
    return out;
  },
};
