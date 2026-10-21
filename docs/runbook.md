# Payroll QA runbook

Novum Partners' pre-run payroll QA system. Specification: the Claude Doc "Payroll QA System: Build Specification" (October 20, 2026). This runbook is for the payroll lead and whoever operates the deployment.

## What runs when

| When | What | Where |
| --- | --- | --- |
| Every hour | The cycle tick: for every live client, find the next pay period, ensure its run, and execute every stage whose window is open and has not run (cutoff minus 5 days specialist reminder; minus 3 days client reminder draft; minus 2 days QA; minus 1 day escalate open blocks; minus 4 hours escalate missing approval; at cutoff mark late). | `GET /api/cron/cycle` (Vercel Cron, `CRON_SECRET`) |
| 12:30 UTC daily | Post-submit comparison: for every run recorded as submitted at least 6 hours ago and not yet compared, pull the processed register and open a block exception per difference. | `GET /api/cron/post-submit` |
| On each JotForm submission | A change request lands in the ledger with status `received`. Duplicates are no-ops. | `POST /api/webhooks/jotform/<JOTFORM_WEBHOOK_SECRET>` |
| On demand | QA re-run, preview, approval, submission, profile draft and signature. | The dashboard |

Cutoff for a run is `pay date - cutoffDaysBeforePayDate` at `cutoffHourUtc` (defaults: 2 days, 22:00 UTC, which is 5 pm Central standard time). Both are per client under Admin.

A missed tick loses nothing: a stage still open on the next tick runs then. A stage never runs twice; each is a `stage:<name>` event on the run.

## The five-day sequence, as the pod works it

1. **Cutoff minus 5 days.** The specialist gets a Slack message (or an inbox entry) listing requests still `received` and calendar items (anniversary increases, benefit eligibility, expiring housing designations). Apply or reject every request under the client's page before QA; a `received` request effective by period end is an A5 block.
2. **Cutoff minus 3 days.** The specialist receives the client reminder text and sends it to the client contact. The system never messages a client.
3. **Cutoff minus 2 days.** QA runs. The report (Markdown, JSON, PDF) files to the client's Box folder. A clean run is quiet; exceptions produce a digest with the queue link.
4. **Cutoff minus 1 day.** Work the queue. Every exception is cleared (corrected in the platform; the next QA run confirms it) or documented (stands as is; the note is the record). Re-run QA until no block is open. Compose the client preview; send the link or the text to the client. Record the approval (the client approves through the link, or you record a reply approval by name). Open blocks at this point escalate to the lead automatically.
5. **Cutoff.** Submit in Gusto or Rippling by hand, then press "I submitted" on the run. The system never submits. The next morning the processed register is compared to the approved draft; any difference is a post-submit exception.

## Onboarding a client

1. Admin: add the client (platform, platform company id, frequency, cutoff rule, Box folder id, specialist, contact, registered states). Status starts at `onboarding`.
2. Client page, Payroll Profile: **Draft from the platform and Box**. The builder pulls the roster and current draft, reads the Box folder, extracts every stated amount, date and policy with its source file, and writes a question for every disagreement and every missing source document.
3. Resolve every question (platform is right, document is right, or a corrected value). A minister with no board housing resolution on file cannot be signed; obtain the resolution first.
4. Tick the C4 confirmation after checking the housing earning type in the platform, then **Sign**. Signature records who and when, files the profile PDF to Box, and moves the client to `live`. From then on the profile changes only through change requests.
5. For a Rippling client (export mode), also keep the next period dates current under Admin; the export watcher reads `payroll-exports/<period end>/register.csv` and `roster.csv` from the client's Box folder.

Run each cohort in parallel with the current process for two cycles (spec section 09). The lead reviews every disagreement weekly.

## When something is wrong

| Symptom | Where to look | What it usually is |
| --- | --- | --- |
| Queue is empty | Inbox; `/api/health` | Cycle not running (`CRON_SECRET` unset or cron disabled), Gusto token missing, or no live client with a signed profile. |
| "no unsubmitted draft" message | Gusto | The pay period has not been created on the platform yet; the QA stage retries every tick until it is. |
| "no signed Payroll Profile" | Client page | The profile was never signed or the client was re-drafted. QA refuses to run without a signature. |
| A5 block on every run | Client page, ledger | A request sits in `received` with an effective date in the past. Apply or reject it. |
| C4 review every run | Profile | The platform does not report the housing earning type's taxability and the C4 confirmation was not ticked at signature. Confirm it and re-sign after a profile change, or record the confirmation under Admin. |
| C2 info "cap not verified" | Gusto | Year-to-date housing is summed from the year's processed payrolls when the draft has a housing line; the info means that sweep found nothing to sum (first payroll of the year) or the platform is Rippling without a YTD column. |
| Escalation to the lead | Run page, run log | Open blocks at cutoff minus 1 day, or no approval at cutoff minus 4 hours. Both are logged on the run. |
| Sign-in refused | Admin, access list | The email is not listed, is inactive, or signed in from a different Microsoft account than the one first bound. |
| Webhook returns `ok:false` | Audit log (`jotform.rejected`) | A required field was blank, a date was impossible, or the client or employee named on the form is not on the profile. Fix the form or the profile; JotForm can resend the submission. |

Nothing in the system writes to Gusto or Rippling. Every correction is made in the platform by a person; the next QA run confirms it.

## Deploying

- Vercel project with root directory `apps/web`. The build command runs the database migrations (`drizzle-kit migrate`) and then `next build`; a migration failure fails the deploy.
- Set every variable in `.env.example`. `CRON_SECRET` guards the cron routes; `JOTFORM_WEBHOOK_SECRET` is the URL segment in every form's webhook; `JOTFORM_FORMS` is the form registry (`config/jotform-forms.example.json` shows the shape).
- Microsoft Entra: a single-tenant app registration in Novum's tenant with redirect URI `APP_BASE_URL/auth/microsoft/callback`, ID tokens enabled, a client secret. Only accounts the tenant issued are admitted; the access list under Admin decides who gets in.
- Gusto: an accountant partner app with read scopes. Put its client id and secret in `GUSTO_CLIENT_ID` and `GUSTO_CLIENT_SECRET`, register `APP_BASE_URL/auth/gusto/callback` as the redirect URI on the app, then have the lead press **Connect Gusto** under Admin and sign in as Novum's firm admin. Access tokens live two hours; the system refreshes them and stores the rotated pair encrypted before any request proceeds. If Admin shows a last error on the connection, press Re-authorize. Box: a Client Credentials app authorized in the Box Admin Console, invited as a collaborator on each client's payroll folder (Viewer plus upload). Slack: a bot token with `chat:write`; without it, every message is recorded in the inbox only.
- First sign-in: there is no bootstrap account. Seed the lead with `pnpm --filter @payroll-qa/db seed:dev` against a development database, or insert the first `users` row by hand with role `lead`; the person then signs in with Microsoft.

## Retention and audit

Runs keep the draft snapshot, the prior snapshot, every QA attempt's exceptions with their decisions, the client approval record, the submitted register, and the Box file ids of the reports. Nothing is deleted. The audit log records sign-ins, every read of a run's exceptions, every decision, every profile signature and question resolution, every request applied or rejected, approvals and submissions, and admin changes. Retention is a database setting: keep seven years for runs, reports and exceptions, and the life of the client plus seven years for profiles.

## Verification

```
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm build
```

The engine suite holds every check to a passing and a failing fixture and tests every threshold at its boundary; the database suite runs the repository against pglite with the real migration; the jobs suite walks the five-day sequence tick by tick.
