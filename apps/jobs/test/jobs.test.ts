import { describe, expect, it } from "vitest";
import { runCycle } from "../src/cycle";
import { compareRegisters } from "../src/diff";
import { postSubmitCompare } from "../src/post-submit";
import { runQaForClient } from "../src/run-qa";
import { cutoffFor, openStages } from "../src/schedule";
import { fakeDeps } from "./fake-deps";
import { emp, request } from "../../../packages/engine/test/fixtures";

const at = (s: string) => new Date(s);

describe("schedule", () => {
  it("computes the cutoff from the pay date, the client's days-before and cutoff hour", () => {
    expect(cutoffFor("2026-11-20", 2, 22).toISOString()).toBe("2026-11-18T22:00:00.000Z");
    expect(cutoffFor("2026-11-20", 3, 17).toISOString()).toBe("2026-11-17T17:00:00.000Z");
  });
  it("opens each stage at its offset and closes everything but late at cutoff", () => {
    const cutoff = at("2026-11-18T22:00:00Z");
    expect(openStages(cutoff, at("2026-11-13T21:59:59Z"))).toEqual([]);
    expect(openStages(cutoff, at("2026-11-13T22:00:00Z"))).toEqual(["remind_specialist"]);
    expect(openStages(cutoff, at("2026-11-15T22:00:00Z"))).toEqual(["remind_specialist", "remind_client"]);
    expect(openStages(cutoff, at("2026-11-16T22:00:00Z"))).toEqual(["remind_specialist", "remind_client", "qa"]);
    expect(openStages(cutoff, at("2026-11-17T22:00:00Z"))).toEqual(["remind_specialist", "remind_client", "qa", "escalate_blocks"]);
    expect(openStages(cutoff, at("2026-11-18T18:00:00Z"))).toEqual(["remind_specialist", "remind_client", "qa", "escalate_blocks", "escalate_no_approval"]);
    expect(openStages(cutoff, at("2026-11-18T22:00:00Z"))).toEqual(["late"]);
  });
});

describe("run-qa", () => {
  it("files markdown, json and pdf to Box, records the stage, and stays quiet on a pass", async () => {
    const d = fakeDeps();
    const run = await d.ensureRun({ clientId: "c_grace", period: d.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22) });
    const out = await runQaForClient(d, d.client, run, { trigger: "scheduled" });
    expect(out).toMatchObject({ status: "pass", attempt: 1, counts: { block: 0, review: 0, info: 0 } });
    expect(d.files).toEqual(["Payroll QA 2026-11-15 attempt 1.md", "Payroll QA 2026-11-15 attempt 1.json", "Payroll QA 2026-11-15 attempt 1.pdf"]);
    expect(d.notifications).toEqual([]);
    expect(d.events.map((e) => e.kind)).toEqual(["stage:qa"]);
  });

  it("notifies the specialist with the queue link on exceptions; a manual re-run is its own event", async () => {
    const d = fakeDeps();
    d.draft!.blockers = [{ code: "bank", message: "Bank unverified" }];
    const run = await d.ensureRun({ clientId: "c_grace", period: d.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22) });
    const out = await runQaForClient(d, d.client, run, { trigger: "manual" });
    expect(out.status).toBe("exceptions");
    expect(d.notifications[0]).toMatchObject({ audience: "specialist", recipient: "U_SPEC", kind: "qa_digest" });
    expect(d.notifications[0]!.text).toContain("1 block");
    expect(d.notifications[0]!.text).toContain("runs/run_2026-11-15");
    expect(d.events.map((e) => e.kind)).toEqual(["qa_rerun_requested"]);
  });

  it("refuses to run without a signed profile and says so", async () => {
    const d = fakeDeps();
    d.profile.signedAt = undefined;
    const run = await d.ensureRun({ clientId: "c_grace", period: d.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22) });
    const out = await runQaForClient(d, d.client, run, { trigger: "scheduled" });
    expect(out.status).toBe("no_profile");
    expect(d.notifications[0]!.text).toContain("no signed Payroll Profile");
    expect(d.files).toEqual([]);
  });

  it("does not run against a draft for a different period than the run", async () => {
    const d = fakeDeps();
    const run = await d.ensureRun({ clientId: "c_grace", period: { start: "2026-11-16", end: "2026-11-30", payDate: "2026-12-05" }, cutoffAt: cutoffFor("2026-12-05", 2, 22) });
    const out = await runQaForClient(d, d.client, run, { trigger: "scheduled" });
    expect(out.status).toBe("no_draft");
  });
});

describe("cycle", () => {
  it("runs each stage once as its window opens, across ticks, and never twice", async () => {
    const d = fakeDeps();
    d.ledger = [request({ type: "one_time_pay", employeeId: "e_admin", status: "received", payload: { kind: "one_time_pay", earningType: "bonus", amountCents: 50000 } })];
    d.profile.employees.find((e) => e.id === "e_fac")!.benefitEligibilityDate = "2026-11-05";
    // cutoff 2026-11-18T22:00Z
    d.clock = at("2026-11-13T23:00:00Z"); // c-5 window
    let out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["remind_specialist"]);
    expect(d.notifications.at(-1)).toMatchObject({ audience: "specialist", kind: "remind_specialist" });
    expect(d.notifications.at(-1)!.text).toContain("one time pay effective 2026-11-01 for Maria Soto received 2026-10-28 and not yet applied");
    expect(d.notifications.at(-1)!.text).toContain("Tom Hale: benefit elections by eligibility date 2026-11-05");
    expect(d.pulls).toEqual(["nextPeriod"]); // no full draft pull for a reminder

    d.clock = at("2026-11-14T23:00:00Z");
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual([]); // nothing new opened, nothing repeated

    d.clock = at("2026-11-15T23:00:00Z"); // c-3
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["remind_client"]);
    expect(d.notifications.at(-1)).toMatchObject({ audience: "client_contact_via_specialist", recipient: "U_SPEC" });
    expect(d.notifications.at(-1)!.text).toContain("Church Admin <admin@grace.example>");
    expect(d.notifications.at(-1)!.text).not.toContain("benefit elections"); // the client is asked for inputs, not for our calendar

    d.clock = at("2026-11-16T23:00:00Z"); // c-2: QA runs; the received request is an A5 block
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["qa"]);
    expect(d.runs.get("run_2026-11-15")!.qaAttempt).toBe(1);
    expect(d.notifications.at(-1)).toMatchObject({ kind: "qa_digest" });
    expect(await d.openCounts("run_2026-11-15")).toEqual({ block: 1, review: 1, info: 0 }); // A5 block, D2 eligibility review

    d.clock = at("2026-11-17T23:00:00Z"); // c-1 with a block still open: escalate to the lead
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["escalate_blocks"]);
    expect(d.notifications.at(-1)).toMatchObject({ audience: "lead", recipient: "U_LEAD", kind: "escalation_blocks" });
    expect(d.events.find((e) => e.kind === "stage:escalate_blocks")!.detail).toEqual({ openBlock: 1, escalated: true });

    d.clock = at("2026-11-18T19:00:00Z"); // c-4h, no approval
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["escalate_no_approval"]);
    expect(d.notifications.at(-1)).toMatchObject({ audience: "lead", kind: "escalation_no_approval" });

    d.clock = at("2026-11-18T22:00:00Z"); // cutoff passed, not submitted
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["late"]);
    expect(d.runs.get("run_2026-11-15")!.status).toBe("late");
    out = await runCycle(d);
    expect(out[0]!.stages).toEqual([]);
    expect(d.events.filter((e) => e.kind.startsWith("stage:")).map((e) => e.kind)).toEqual([
      "stage:remind_specialist", "stage:remind_client", "stage:qa", "stage:escalate_blocks", "stage:escalate_no_approval", "stage:late",
    ]);
  });

  it("a missed tick loses nothing: every open stage runs on the next tick, in order", async () => {
    const d = fakeDeps();
    d.clock = at("2026-11-17T23:00:00Z");
    const out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["remind_specialist", "remind_client", "qa", "escalate_blocks"]);
    expect(d.notifications.map((n) => n.kind)).toEqual([]); // clean run, nothing open: reminders and escalation have nothing to say
    expect(d.events.find((e) => e.kind === "stage:escalate_blocks")!.detail).toEqual({ openBlock: 0, escalated: false });
  });

  it("the scheduled QA stage does not re-run QA already run on demand, and the no-approval check is quiet once approved", async () => {
    const d = fakeDeps();
    const run = await d.ensureRun({ clientId: "c_grace", period: d.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22) });
    await runQaForClient(d, d.client, run, { trigger: "manual" });
    d.runs.get(run.id)!.status = "client_approved";
    d.clock = at("2026-11-18T19:00:00Z");
    const out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["remind_specialist", "remind_client", "qa", "escalate_blocks", "escalate_no_approval"]);
    expect(d.runs.get(run.id)!.qaAttempt).toBe(1);
    expect(d.events.find((e) => e.kind === "stage:qa")!.detail).toEqual({ skipped: "already run on demand" });
    expect(d.notifications.filter((n) => n.audience === "lead")).toEqual([]);
  });

  it("skips clients with no signed profile, no next period, or a submitted run; an adapter error is reported per client", async () => {
    const d = fakeDeps({ profileSignedAt: undefined });
    expect((await runCycle(d))[0]).toEqual({ clientId: "c_grace", stages: [] });
    const e = fakeDeps();
    e.draft = null;
    expect((await runCycle(e))[0]).toEqual({ clientId: "c_grace", stages: [] });
    const f = fakeDeps();
    f.clock = at("2026-11-17T23:00:00Z");
    const run = await f.ensureRun({ clientId: "c_grace", period: f.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22) });
    f.runs.get(run.id)!.status = "submitted";
    expect((await runCycle(f))[0]!.stages).toEqual([]);
    const g = fakeDeps();
    g.adapter = () => { throw new Error("Gusto 503"); };
    expect((await runCycle(g))[0]).toMatchObject({ error: "Gusto 503" });
  });

  it("the QA stage waits for the draft rather than marking itself done", async () => {
    const d = fakeDeps();
    d.clock = at("2026-12-01T23:00:00Z"); // c-2 for the 12-05 pay date
    const draft = d.draft!;
    d.draft = { ...draft, period: { start: "2026-11-16", end: "2026-11-30", payDate: "2026-12-05" } };
    // nextPeriod now says the 11-30 period; make the pull come back as a different period to simulate the platform lagging
    const real = d.adapter;
    d.adapter = () => ({ ...real("gusto"), pullDraft: async () => draft });
    const out = await runCycle(d);
    expect(out[0]!.stages).toEqual(["remind_specialist", "remind_client"]); // qa is open but not done
    expect(d.notifications.at(-1)?.kind).toBe("no_draft");
    expect(d.events.some((e) => e.kind === "stage:qa")).toBe(false);
  });
});

describe("post-submit comparison", () => {
  it("compares the processed register to the approved draft and opens an exception per difference", async () => {
    const d = fakeDeps();
    d.clock = at("2026-11-16T23:00:00Z");
    const run = await d.ensureRun({ clientId: "c_grace", period: d.draft!.period, cutoffAt: cutoffFor("2026-11-20", 2, 22), platformPayrollId: d.draft!.platformPayrollId });
    await runQaForClient(d, d.client, run, { trigger: "scheduled" });
    const r = d.runs.get(run.id)!;
    r.status = "submitted";
    r.submittedAt = at("2026-11-18T20:00:00Z");
    d.clock = at("2026-11-19T01:00:00Z"); // too soon (6-hour wait)
    expect(await postSubmitCompare(d)).toEqual([]);
    d.clock = at("2026-11-19T07:00:00Z");
    expect(await postSubmitCompare(d)).toEqual([{ runId: run.id, skipped: "not processed yet" }]);
    const processed = structuredClone(d.draft!);
    emp(processed, "g_1002").grossCents = 260000;
    emp(processed, "g_1002").earnings = [{ type: "regular", amountCents: 260000 }];
    d.processed = processed;
    expect(await postSubmitCompare(d)).toEqual([{ runId: run.id, differences: 1 }]);
    expect(d.notifications.at(-1)).toMatchObject({ kind: "post_submit", audience: "specialist" });
    expect(await postSubmitCompare(d)).toEqual([]); // compared once
  });

  it("compareRegisters names every difference and nothing else", () => {
    const a = fakeDeps().draft!;
    const b = structuredClone(a);
    expect(compareRegisters(a, b)).toEqual([]);
    emp(b, "g_1003").netCents -= 1;
    emp(b, "g_1002").deductions[0]!.employerCents = 43000;
    b.employees = b.employees.filter((e) => e.platformEmployeeId !== "g_1001");
    b.employees.push({ ...emp(a, "g_1001"), platformEmployeeId: "g_new", name: "New Person", grossCents: 100 });
    const diffs = compareRegisters(a, b);
    expect(diffs.map((x) => [x.employeeName, x.actual])).toEqual([
      ["Pastor Daniel Reyes", "not on the submitted register"],
      ["Maria Soto", "Medical PPO employee $180.00 / employer $430.00 vs $180.00 / $420.00"],
      ["Tom Hale", "net $1,505.35 vs $1,505.36"],
      ["New Person", "gross $1.00 submitted"],
    ]);
  });
});
