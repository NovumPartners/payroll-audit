/** Pure date arithmetic for the cycle. Everything takes `now` as an argument. */

export const DAY = 864e5;
export const HOUR = 36e5;

/** Cutoff: `days` before the pay date, at the client's cutoff hour (UTC). */
export function cutoffFor(payDate: string, cutoffDaysBeforePayDate: number, cutoffHourUtc: number): Date {
  return new Date(Date.parse(`${payDate}T00:00:00Z`) - cutoffDaysBeforePayDate * DAY + cutoffHourUtc * HOUR);
}

export type Stage = "remind_specialist" | "remind_client" | "qa" | "escalate_blocks" | "escalate_no_approval" | "late";

/** Each stage opens at its offset from cutoff and stays open until cutoff (or forever, for `late`). */
export const STAGE_OFFSET_MS: Record<Stage, number> = {
  remind_specialist: -5 * DAY,
  remind_client: -3 * DAY,
  qa: -2 * DAY,
  escalate_blocks: -1 * DAY,
  escalate_no_approval: -4 * HOUR,
  late: 0,
};

/** Stages whose window is open at `now` for a run with this cutoff, in order. */
export function openStages(cutoffAt: Date, now: Date): Stage[] {
  const t = now.getTime();
  const c = cutoffAt.getTime();
  return (Object.keys(STAGE_OFFSET_MS) as Stage[]).filter((st) => {
    const opens = c + STAGE_OFFSET_MS[st];
    return st === "late" ? t >= c : t >= opens && t < c;
  });
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
