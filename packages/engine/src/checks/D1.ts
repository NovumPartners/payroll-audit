/** D1: every blocker the platform reports is a block on the run. */
import type { Check, Exception } from "../types.js";

export const D1: Check = {
  code: "D1",
  family: "D",
  title: "Platform blockers and warnings",
  severity: "block",
  run(ctx) {
    return ctx.draft.blockers.map<Exception>((b) => {
      const p = b.employeeId ? ctx.profileByPlatformId.get(b.employeeId) : undefined;
      return {
        checkCode: "D1",
        severity: "block",
        employeeId: p?.id,
        employeeName: p?.name,
        expected: "no platform blockers",
        actual: `${b.code}: ${b.message}`,
        sourceOfExpected: "platform_rule",
        description: "The platform reports a blocker that will stop or delay submission.",
      };
    });
  },
};
