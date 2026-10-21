/**
 * B3: hours for an hourly employee above 1.5 times standard hours, or above
 * the hard cap. The cap is stated per biweekly period (80) and scaled to the
 * pay frequency, so a semimonthly full-timer at 86.67 hours does not fire.
 */
import type { Check, Exception } from "../types";
import { scaledHours } from "../context";
import { nameFor } from "./_b";

export const B3: Check = {
  code: "B3",
  family: "B",
  title: "Hourly hours unusually high",
  severity: "review",
  run(ctx) {
    const out: Exception[] = [];
    const cap = scaledHours(ctx.config.hoursHardCap, ctx.draft.payFrequency);
    for (const d of ctx.draft.employees) {
      if (d.payType !== "hourly") continue;
      const prof = ctx.profileByPlatformId.get(d.platformEmployeeId);
      const standard = prof && prof.standardHours > 0 ? prof.standardHours : cap;
      const limit = Math.min(standard * ctx.config.hoursMultiplier, cap);
      if (d.hours > limit + 1e-9) {
        out.push({
          checkCode: "B3",
          severity: "review",
          employeeId: prof?.id,
          employeeName: nameFor(ctx, d),
          expected: `hours at or under ${Number(limit.toFixed(2))}`,
          actual: `${d.hours} hours`,
          sourceOfExpected: "profile",
          description: `Hours exceed ${ctx.config.hoursMultiplier}x standard or the ${Number(cap.toFixed(2))}-hour cap for a ${ctx.draft.payFrequency} period; confirm the timesheet.`,
        });
      }
    }
    return out;
  },
};
