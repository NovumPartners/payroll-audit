/**
 * C8: each active employee's work state matches the profile, is on the
 * profile's list of registered states, and (when the platform reports tax
 * setup) has tax setup complete on the platform.
 */
import type { Check, Exception } from "../types";

export const C8: Check = {
  code: "C8",
  family: "C",
  title: "Work state matches platform tax setup",
  severity: "block",
  run(ctx) {
    const out: Exception[] = [];
    const registered = new Set(ctx.profile.registeredStates);
    const platform = ctx.draft.stateTaxSetup ? new Set(ctx.draft.stateTaxSetup) : undefined;
    for (const p of ctx.profile.employees) {
      if (p.status !== "active") continue;
      const d = ctx.draftByPlatformId.get(p.platformEmployeeId);
      if (!d) continue;
      if (d.workState !== p.workState) {
        out.push({
          checkCode: "C8",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `work state ${p.workState}`,
          actual: d.workState ? `work state ${d.workState}` : "no work state on the platform",
          sourceOfExpected: "profile",
          description: "Platform work state differs from the profile.",
        });
      }
      if (!d.workState) continue;
      if (!registered.has(d.workState)) {
        out.push({
          checkCode: "C8",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `${d.workState} among the registered states on the profile (${ctx.profile.registeredStates.join(", ") || "none"})`,
          actual: `work state ${d.workState} not registered`,
          sourceOfExpected: "profile",
          description: "Employee works in a state the signed profile does not list as registered.",
        });
      }
      if (platform && !platform.has(d.workState)) {
        out.push({
          checkCode: "C8",
          severity: "block",
          employeeId: p.id,
          employeeName: p.name,
          expected: `state tax setup complete for ${d.workState} on the platform`,
          actual: `no tax setup for ${d.workState}`,
          sourceOfExpected: "platform_rule",
          description: "Employee works in a state with no tax setup on the platform.",
        });
      }
    }
    return out;
  },
};
