/** Shared helpers for family B (platform to prior period). */
import type { CheckContext, ChangeRequest, DraftEmployee } from "../types.js";

/** Non-rejected requests for an employee (by platform id) effective after the prior period end and on or before this period end. */
export function requestsFor(ctx: CheckContext, platformId: string): ChangeRequest[] {
  const prof = ctx.profileByPlatformId.get(platformId);
  if (!prof) return [];
  const { end } = ctx.draft.period;
  const priorEnd = ctx.prior?.period.end ?? "0000-00-00";
  return ctx.ledgerActive.filter((c) => c.employeeId === prof.id && c.effectiveDate > priorEnd && c.effectiveDate <= end);
}

/** Requests effective inside the prior period (the prior run was partial for them). */
export function requestsInPrior(ctx: CheckContext, platformId: string): ChangeRequest[] {
  const prof = ctx.profileByPlatformId.get(platformId);
  if (!prof || !ctx.prior) return [];
  const { start, end } = ctx.prior.period;
  return ctx.ledgerActive.filter((c) => c.employeeId === prof.id && c.effectiveDate >= start && c.effectiveDate <= end);
}

export function nameFor(ctx: CheckContext, d: DraftEmployee): string {
  return ctx.profileByPlatformId.get(d.platformEmployeeId)?.name ?? d.name;
}

export function profId(ctx: CheckContext, d: DraftEmployee): string | undefined {
  return ctx.profileByPlatformId.get(d.platformEmployeeId)?.id;
}
