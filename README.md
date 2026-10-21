# Payroll QA

Novum Partners' pre-run payroll QA system. Reconciles every client payroll draft on Gusto or Rippling against a signed Payroll Profile, the JotForm change ledger, and the prior period before a specialist submits. Specification: the Claude Doc "Payroll QA System: Build Specification" (October 20, 2026). Operations: `docs/runbook.md`.

The system reads from payroll platforms and never writes to them. Every correction is made in the platform by a person; the next QA run confirms it.

## What is built

| Package | Contents | Tests |
| --- | --- | --- |
| `packages/engine` | Normalized draft schema, the 22 checks (A1 to D2, one file each), proration from first principles, movements for the client preview, report and preview renderers | 118 |
| `packages/adapters` | Gusto partner API adapter (read-only, verified endpoints, benefits catalog, tax requirements, year-to-date housing), Rippling CSV export adapter, JotForm mapper with constant-time secret, Box store with client-credentials tokens, Slack notifier | 22 |
| `packages/db` | Drizzle Postgres schema and migrations; the repository with the control gates in code (approval refused with an open block, signature refused for a minister without a resolution, decisions require a note, attempts and decisions kept) | 17 (pglite) |
| `packages/profile-builder` | The five builder steps: platform draft, document extraction with Claude under a JSON schema with excerpt verification, comparison, flags, draft for review | 7 |
| `apps/jobs` | The hourly cycle tick (cutoff minus 5, 3, 2, 1 days, minus 4 hours, late), the QA run with Box filing, the post-submit register comparison | 13 |
| `apps/web` | Next.js dashboard: Microsoft Entra sign-in, queue, run detail, client ledger, profile review and signature, admin, inbox, public signed preview, cron and webhook routes | 6 |

## Commands

```
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm build
```

## Check families

- A: ledger to platform (A1 to A5), block.
- B: platform to prior period (B1 to B7), block and review.
- C: platform to Payroll Profile (C1 to C8), block and review. C2 to C4 carry the minister rules: housing designation amount and annual cap, FICA exemption, voluntary withholding, earning type excluded from taxable wages.
- D: platform blockers and calendar items (D1, D2).

Thresholds live in `DEFAULT_CONFIG` (`packages/engine/src/types.ts`) and are overridden per client under Admin. Where the platform cannot report a fact (year-to-date housing, a deduction's tax treatment, the housing earning type's taxability), the engine says the fact was not verified rather than assuming it.

## Decisions taken in the build that the specification left open

- **Slack delivery goes to Novum people only.** The specialist, the lead and the pod channel receive Slack messages when a bot token is configured; the client reminder and the client preview are delivered to the specialist as text to send. Every message is also recorded in the inbox, so the system is complete without Slack.
- **The cycle is one hourly tick, not five crons.** Each stage opens at its offset from the client's own cutoff and is recorded on the run, so a missed hour is caught up and nothing repeats.
- **Approval through the preview link is refused after cutoff and while a block is open**, in the repository, not only in the page.
- **A rate change request records the previous rate when applied**, because the profile then carries the new rate and A2 could not otherwise prorate a mid-period change; when the previous rate is unknown, A2 reports the proration as not verifiable instead of guessing.

## Environment

See `.env.example`. Nothing is committed with a value.

## What Brad must still supply (spec section 10)

- Gusto accountant partner API credential for Novum's firm account.
- JotForm form ids and the field list for every payroll change form, as `JOTFORM_FORMS` (shape in `config/jotform-forms.example.json`).
- Box folder structure for a standard payroll client and the service account.
- Rippling: partner API access, or the export owner until then.
- The payroll lead and the five pilot clients; the Slack channel for pod notifications.
