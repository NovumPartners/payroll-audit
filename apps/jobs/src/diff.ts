/**
 * Post-submit comparison: the processed register against the approved draft.
 * Pure. Every difference is one exception with expected (approved) and actual
 * (submitted). Severity is assigned by the repository (always block).
 */
import type { DraftEmployee, DraftRun, Exception, PayrollProfile } from "@payroll-qa/engine";
import { dollars } from "@payroll-qa/engine";

type Diff = Omit<Exception, "severity">;

export function compareRegisters(approved: DraftRun, submitted: DraftRun, profile?: PayrollProfile): Diff[] {
  const out: Diff[] = [];
  const profId = (pid: string) => profile?.employees.find((e) => e.platformEmployeeId === pid)?.id;
  const name = (e: DraftEmployee) => profile?.employees.find((p) => p.platformEmployeeId === e.platformEmployeeId)?.name ?? e.name;
  const a = new Map(approved.employees.map((e) => [e.platformEmployeeId, e]));
  const b = new Map(submitted.employees.map((e) => [e.platformEmployeeId, e]));
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const pid of ids) {
    const x = a.get(pid);
    const y = b.get(pid);
    if (x && !y) {
      out.push({ checkCode: "POST_SUBMIT", employeeId: profId(pid), employeeName: name(x), expected: `gross ${dollars(x.grossCents)} (approved draft)`, actual: "not on the submitted register", sourceOfExpected: "prior_run", description: "An employee on the approved draft is missing from the submitted register." });
      continue;
    }
    if (!x && y) {
      out.push({ checkCode: "POST_SUBMIT", employeeId: profId(pid), employeeName: name(y), expected: "not on the approved draft", actual: `gross ${dollars(y.grossCents)} submitted`, sourceOfExpected: "prior_run", description: "An employee was paid who was not on the approved draft." });
      continue;
    }
    if (!x || !y) continue;
    const problems: string[] = [];
    if (x.grossCents !== y.grossCents) problems.push(`gross ${dollars(y.grossCents)} vs ${dollars(x.grossCents)}`);
    if (x.netCents !== y.netCents) problems.push(`net ${dollars(y.netCents)} vs ${dollars(x.netCents)}`);
    const types = [...new Set([...x.earnings.map((l) => l.type), ...y.earnings.map((l) => l.type)])].sort();
    for (const t of types) {
      const ex = x.earnings.filter((l) => l.type === t).reduce((s, l) => s + l.amountCents, 0);
      const ac = y.earnings.filter((l) => l.type === t).reduce((s, l) => s + l.amountCents, 0);
      if (ex !== ac) problems.push(`${t} ${dollars(ac)} vs ${dollars(ex)}`);
    }
    const dnames = [...new Set([...x.deductions.map((d) => d.planId ?? d.name), ...y.deductions.map((d) => d.planId ?? d.name)])].sort();
    for (const k of dnames) {
      const ex = x.deductions.filter((d) => (d.planId ?? d.name) === k);
      const ac = y.deductions.filter((d) => (d.planId ?? d.name) === k);
      const sum = (ls: typeof ex) => [ls.reduce((s, d) => s + d.employeeCents, 0), ls.reduce((s, d) => s + d.employerCents, 0)] as const;
      const [ee, er] = sum(ex);
      const [ae, ar] = sum(ac);
      if (ee !== ae || er !== ar) problems.push(`${ex[0]?.name ?? ac[0]?.name ?? k} employee ${dollars(ae)} / employer ${dollars(ar)} vs ${dollars(ee)} / ${dollars(er)}`);
    }
    if (problems.length) {
      out.push({ checkCode: "POST_SUBMIT", employeeId: profId(pid), employeeName: name(x), expected: `as approved: gross ${dollars(x.grossCents)}, net ${dollars(x.netCents)}`, actual: problems.join("; "), sourceOfExpected: "prior_run", description: "The submitted register differs from the approved draft." });
    }
  }
  return out;
}
