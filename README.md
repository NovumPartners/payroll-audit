# Payroll QA

Novum Partners' pre-run payroll QA system. Reconciles every client payroll draft on Gusto or Rippling against a signed Payroll Profile, the JotForm change ledger, and the prior period before a specialist submits. Specification: the Claude Doc "Payroll QA System: Build Specification" (October 20, 2026).

## What is built (milestones 1 and 2, engine complete)

| Package | Status | Contents |
| --- | --- | --- |
| `packages/engine` | Complete, 38 tests | Normalized draft schema, 22 reconciliation checks (A1 to D2), config thresholds, report renderer |
| `packages/db` | Schema complete | Drizzle Postgres schema for clients, employees, housing, benefits, time off, change ledger, runs, exceptions, profile questions, audit log |
| `packages/adapters` | Mappers complete, 5 tests | Gusto partner API adapter and mapper, Rippling CSV adapter, JotForm webhook mapper, Box store, Slack drafts |
| `packages/profile-builder` | Step 1 of 5 | Mechanical profile draft from a platform pull with questions for every minister-looking line |
| `apps/jobs` | Core job complete, 3 tests | `run-qa`: cutoff-minus-2 job that pulls, checks, persists, files to Box, drafts the digest |
| `apps/web` | Not started | Exceptions queue, profile review, admin (milestone 3) |

## Commands

```
pnpm install
pnpm -r test
pnpm -r typecheck
```

## What the engine needs from the rest of the system

- A signed `PayrollProfile` per client (the `clients.profile_signed_at` gate; the job refuses to run without it).
- The change ledger (`change_requests`) with statuses kept current by the specialist.
- A normalized `DraftRun` for the current period and, when one exists, the prior submitted run.

## Check families

- A: ledger to platform (A1 to A5), block.
- B: platform to prior period (B1 to B7), block and review.
- C: platform to Payroll Profile (C1 to C8), block and review. C2 to C4 carry the minister rules: housing designation amount and annual cap, FICA exemption, voluntary withholding, earning type excluded from taxable wages.
- D: platform blockers and calendar items (D1, D2).

Thresholds live in `DEFAULT_CONFIG` (`packages/engine/src/types.ts`) and can be overridden per client via `clients.threshold_overrides`.

## Environment (not committed)

```
DATABASE_URL=
GUSTO_ACCESS_TOKEN=         # accountant partner OAuth token, read scopes only
GUSTO_API_BASE=https://api.gusto.com
BOX_ACCESS_TOKEN=           # service account scoped to payroll client folders
JOTFORM_WEBHOOK_SECRET=
SLACK_DRAFT_CHANNEL=
```

The system never writes to Gusto or Rippling. Nothing posts to Slack; the system creates drafts a person sends.

## Next

1. `apps/web`: Next.js exceptions queue and profile review, Microsoft Entra SSO.
2. JotForm form ids and field maps into `apps/jobs/src/jotform-config.ts`.
3. Profile builder steps 2 to 5 once Box access is in place.
4. Vercel cron wiring for `run-qa`, `remind`, and `post-submit-compare`.
