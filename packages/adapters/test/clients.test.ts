import { describe, expect, it } from "vitest";
import { GustoAdapter } from "../src/gusto/index";
import { boxCcgTokenProvider, BoxStore } from "../src/box/index";
import { RipplingCsvAdapter } from "../src/rippling/index";

type Route = (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, Route>, log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    log.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    const r = route(url);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
}

const payroll = (uuid: string, start: string, end: string, check: string, processed: boolean, housing = "1500.00") => ({
  payroll_uuid: uuid, processed, check_date: check,
  pay_period: { start_date: start, end_date: end, pay_schedule_uuid: "ps" },
  employee_compensations: [{ employee_uuid: "e1", gross_pay: "5500", net_pay: "5500", fixed_compensations: [{ name: "Regular", amount: "4000" }, { name: "Housing Allowance", amount: housing }], benefits: [], taxes: [] }],
});

function gustoRoutes(log: string[]) {
  const payrolls: Record<string, ReturnType<typeof payroll>> = {
    pr_jan: payroll("pr_jan", "2026-01-01", "2026-01-15", "2026-01-20", true),
    pr_oct: payroll("pr_oct", "2026-10-16", "2026-10-31", "2026-11-05", true),
    pr_nov: payroll("pr_nov", "2026-11-01", "2026-11-15", "2026-11-20", false),
  };
  const routes: Record<string, Route> = {
    "/v1/me": () => ({ body: { roles: { payroll_admin: { companies: [{ uuid: "co", name: "Grace" }] } } } }),
    "/v1/companies/co/payrolls": (u) => {
      const statuses = u.searchParams.get("processing_statuses");
      const list = Object.values(payrolls).filter((p) => (statuses === "processed" ? p.processed : !p.processed));
      return { body: list.map(({ employee_compensations: _, ...rest }) => rest) };
    },
    "/v1/companies/co/payrolls/blockers": () => ({ body: [{ blocker_type: "bank", message: "unverified" }] }),
    "/v1/companies/co/employees": (u) => ({
      body: u.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ uuid: i === 0 ? "e1" : `x${i}`, first_name: "D", last_name: "R", jobs: [{ uuid: "j", primary: true, location_uuid: "l", current_compensation_uuid: "c", compensations: [{ uuid: "c", rate: "96000", payment_unit: "Year" }] }] }))
        : [{ uuid: "e_last", first_name: "Z", last_name: "Z" }],
    }),
    "/v1/companies/co/pay_schedules": () => ({ body: [{ uuid: "ps", frequency: "Twice per month" }] }),
    "/v1/companies/co/locations": () => ({ body: [{ uuid: "l", state: "TX" }] }),
    "/v1/companies/co/company_benefits": () => ({ body: [] }),
    "/v1/benefits": () => ({ body: [] }),
    "/v1/companies/co/tax_requirements": () => ({ body: [{ state: "TX", setup_complete: true }] }),
  };
  for (const [id, p] of Object.entries(payrolls)) routes[`/v1/companies/co/payrolls/${id}`] = () => ({ body: p });
  return { routes, log };
}

describe("GustoAdapter", () => {
  it("pulls the next unprocessed draft, the company blockers, paginated employees, tax setup, and year-to-date housing", async () => {
    const log: string[] = [];
    const { routes } = gustoRoutes(log);
    const g = new GustoAdapter({ accessToken: "t", apiBase: "https://api.gusto-demo.com", fetchImpl: fakeFetch(routes, log), now: () => new Date("2026-11-18T06:00:00Z") });
    expect(await g.listCompanies()).toEqual([{ platformCompanyId: "co", name: "Grace" }]);
    expect(await g.nextPeriod("co", "2026-11-16")).toEqual({ period: { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" }, platformPayrollId: "pr_nov" });
    const d = await g.pullDraft("co", "2026-11-16");
    expect(d?.platformPayrollId).toBe("pr_nov");
    expect(d?.blockers).toEqual([{ code: "bank", message: "unverified", employeeId: undefined }]);
    expect(d?.stateTaxSetup).toEqual(["TX"]);
    expect(d?.employees[0]?.ytdHousingCents).toBe(300000); // Jan + Oct processed payrolls, not the draft itself
    expect(d?.pulledAt).toBe("2026-11-18T06:00:00.000Z");
    expect(log.filter((l) => l.includes("/employees"))).toHaveLength(2); // page 1 full, page 2 short
    expect(log.some((l) => l.includes("/payrolls/pr_nov?include=benefits&include=deductions&include=taxes"))).toBe(true);
    expect(log.some((l) => l.includes("processing_statuses=processed&start_date=2026-01-01&end_date=2026-11-20"))).toBe(true);
    expect(log.every((l) => l.startsWith("GET "))).toBe(true); // never writes
  });

  it("pulls the latest processed run before a date as the prior, without the year-to-date sweep", async () => {
    const log: string[] = [];
    const { routes } = gustoRoutes(log);
    const g = new GustoAdapter({ accessToken: "t", fetchImpl: fakeFetch(routes, log) });
    const p = await g.pullPrior("co", "2026-11-01");
    expect(p?.platformPayrollId).toBe("pr_oct");
    expect(p?.employees[0]?.ytdHousingCents).toBeUndefined();
    expect(log.filter((l) => l.includes("/payrolls/pr_jan"))).toHaveLength(0);
  });

  it("retries on 429 with the Retry-After header and gives up after four retries", async () => {
    let calls = 0;
    const waits: number[] = [];
    const g = new GustoAdapter({
      accessToken: "t",
      fetchImpl: fakeFetch({ "/v1/me": () => { calls++; return calls < 3 ? { status: 429, headers: { "retry-after": "2" } } : { body: { roles: { payroll_admin: { companies: [] } } } }; } }),
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(await g.listCompanies()).toEqual([]);
    expect(waits).toEqual([2000, 2000]);
    const always = new GustoAdapter({ accessToken: "t", fetchImpl: fakeFetch({ "/v1/me": () => ({ status: 429 }) }), sleep: async () => {} });
    await expect(always.listCompanies()).rejects.toThrow(/Gusto 429/);
  });

  it("returns null when there is no unprocessed payroll", async () => {
    const g = new GustoAdapter({ accessToken: "t", fetchImpl: fakeFetch({ "/v1/companies/co/payrolls": () => ({ body: [] }) }) });
    expect(await g.pullDraft("co", "2026-11-16")).toBeNull();
  });
});

describe("Box", () => {
  it("caches the client-credentials token and re-requests it five minutes before expiry", async () => {
    let t = 0;
    let issued = 0;
    const fetchImpl = fakeFetch({ "/oauth2/token": () => ({ body: { access_token: `tok${++issued}`, expires_in: 3600 } }) });
    const provider = boxCcgTokenProvider({ clientId: "id", clientSecret: "s", subjectId: "ent" }, fetchImpl, () => t);
    expect(await provider()).toBe("tok1");
    t = 54 * 60_000;
    expect(await provider()).toBe("tok1");
    t = 55 * 60_000 + 1;
    expect(await provider()).toBe("tok2");
  });

  it("resolves a relative path through subfolders and reads text", async () => {
    const fetchImpl = fakeFetch({
      "/2.0/folders/root/items": () => ({ body: { total_count: 1, entries: [{ id: "f1", name: "payroll-exports", type: "folder" }] } }),
      "/2.0/folders/f1/items": () => ({ body: { total_count: 1, entries: [{ id: "f2", name: "2026-11-15", type: "folder" }] } }),
      "/2.0/folders/f2/items": () => ({ body: { total_count: 1, entries: [{ id: "file9", name: "register.csv", type: "file", size: 3 }] } }),
      "/2.0/files/file9/content": () => ({ body: "a,b" }),
    });
    const box = new BoxStore("tok", fetchImpl);
    expect(await box.readTextByPath("root", "payroll-exports/2026-11-15/register.csv")).toBe('"a,b"');
    expect(await box.readTextByPath("root", "payroll-exports/2026-11-16/register.csv")).toBeNull();
  });
});

describe("RipplingCsvAdapter", () => {
  it("reads register and roster for the client's next period and returns null when a file is missing", async () => {
    const files: Record<string, string> = {
      "payroll-exports/2026-11-15/register.csv": "Employee ID,Employee Name,Line Type,Line Name,Amount,Hours,Employer Amount\n1,A,Earning,Regular,100,,",
      "payroll-exports/2026-11-15/roster.csv": "Employee ID,Pay Type,Rate,Work State\n1,Salary,2400,TX",
    };
    const a = new RipplingCsvAdapter(async (_f, p) => files[p] ?? null, [{ platformCompanyId: "r1", name: "R", boxFolderId: "box", payFrequency: "semimonthly", nextPeriod: { start: "2026-11-01", end: "2026-11-15", payDate: "2026-11-20" }, priorPeriod: { start: "2026-10-16", end: "2026-10-31", payDate: "2026-11-05" } }], () => new Date("2026-11-18T00:00:00Z"));
    const d = await a.pullDraft("r1");
    expect(d?.employees[0]?.grossCents).toBe(10000);
    expect(d?.pulledAt).toBe("2026-11-18T00:00:00.000Z");
    expect(await a.pullPrior("r1")).toBeNull();
    expect(await a.pullDraft("unknown")).toBeNull();
  });
});

describe("Gusto OAuth", () => {
  it("builds the authorize url and exchanges a code", async () => {
    const { gustoAuthorizeUrl, gustoExchangeCode } = await import("../src/gusto/oauth");
    const cfg = { clientId: "cid", clientSecret: "sec", apiBase: "https://api.gusto-demo.com" };
    expect(gustoAuthorizeUrl(cfg, "https://qa/auth/gusto/callback", "st")).toBe("https://api.gusto-demo.com/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fqa%2Fauth%2Fgusto%2Fcallback&response_type=code&state=st");
    const bodies: unknown[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 7200 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const t = await gustoExchangeCode({ ...cfg, fetchImpl }, "code1", "https://qa/cb", new Date("2026-11-16T00:00:00Z"));
    expect(t).toEqual({ accessToken: "a1", refreshToken: "r1", expiresAt: new Date("2026-11-16T02:00:00Z"), scope: undefined });
    expect(bodies[0]).toMatchObject({ grant_type: "authorization_code", code: "code1", client_id: "cid", client_secret: "sec", redirect_uri: "https://qa/cb" });
  });

  it("the provider refreshes five minutes before expiry, persists the rotated pair before returning, and shares one refresh", async () => {
    const { gustoTokenProvider } = await import("../src/gusto/oauth");
    let t = new Date("2026-11-16T00:00:00Z");
    let stored = { accessToken: "a1", refreshToken: "r1", expiresAt: new Date("2026-11-16T02:00:00Z") };
    const saves: string[] = [];
    let refreshes = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      refreshes++;
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      expect(body.refresh_token).toBe("r1");
      return new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 7200 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = gustoTokenProvider({ clientId: "c", clientSecret: "s", fetchImpl }, { load: async () => stored, save: async (x) => { saves.push(x.refreshToken); stored = x; } }, "https://qa/cb", () => t);
    expect(await provider()).toBe("a1");
    t = new Date("2026-11-16T01:54:59Z");
    expect(await provider()).toBe("a1");
    t = new Date("2026-11-16T01:55:00Z");
    const [x, y] = await Promise.all([provider(), provider()]);
    expect([x, y]).toEqual(["a2", "a2"]);
    expect(refreshes).toBe(1);
    expect(saves).toEqual(["r2"]);
    expect(stored.expiresAt).toEqual(new Date("2026-11-16T03:55:00Z"));
    const empty = gustoTokenProvider({ clientId: "c", clientSecret: "s", fetchImpl }, { load: async () => null, save: async () => {} }, "https://qa/cb");
    await expect(empty()).rejects.toThrow(/not connected/);
  });

  it("the adapter accepts a token provider", async () => {
    let calls = 0;
    const g = new GustoAdapter({ accessToken: async () => `tok${++calls}`, fetchImpl: fakeFetch({ "/v1/me": () => ({ body: { roles: { payroll_admin: { companies: [] } } } }) }) });
    await g.listCompanies();
    await g.listCompanies();
    expect(calls).toBe(2);
  });
});
