# Connecting Payroll QA

Directions for every connection the system needs, in the order they unblock each other. Deployment host: `https://payroll-audit.novumsp.live`. Every value named in capitals is an environment variable in the Vercel project; `.env.example` lists them all.

## 1. Vercel project and Postgres

1. **Database.** Create a Neon project (or Vercel Postgres) in a US region. Copy the pooled connection string into `DATABASE_URL`. Migrations run during every deploy, so no manual schema step.
2. **Project.** In Vercel: Add New Project, import `NovumPartners/payroll-audit`, production branch `main`, **Root Directory `apps/web`**, framework Next.js. Leave install and build commands alone; `apps/web/vercel.json` runs the migrations and then the build, and declares the two crons (hourly cycle, daily post-submit). Hourly cron needs the Pro plan.
3. **Secrets you generate.** Run `openssl rand -base64 48` three times for `APP_SECRET` (signs sessions and preview links; 32 characters minimum), `CRON_SECRET` (guards the cron routes), and `JOTFORM_WEBHOOK_SECRET` (the URL segment on every JotForm webhook). Set `APP_BASE_URL=https://payroll-audit.novumsp.live`.
4. **Domain.** Project, Settings, Domains: add `payroll-audit.novumsp.live`; at the DNS host add the CNAME Vercel shows (`cname.vercel-dns.com`). Wait for the certificate.
5. **First deploy.** Push to `main` or press Deploy. Then open `https://payroll-audit.novumsp.live/login`; the page should render even before sign-in works.
6. **First admin.** The access list is empty, so nobody can sign in yet. From a machine with the production `DATABASE_URL`:
   ```
   git clone https://github.com/NovumPartners/payroll-audit && cd payroll-audit && pnpm install
   DATABASE_URL='<production connection string>' SEED_LEAD_EMAIL=brad@novumsp.com SEED_SPECIALIST_EMAIL=<payroll lead email> pnpm --filter @payroll-qa/db seed:dev
   ```
   This creates the lead and specialist rows (and a fixture client named "Grace Fellowship (fixture)" that you can leave at status onboarding or set to offboarded under Admin). Everyone else is added under Admin after you sign in.

## 2. Microsoft Entra (sign-in)

Needs someone with Application Administrator rights in Novum's tenant.

1. Entra admin center, App registrations, **New registration**. Name `Payroll QA`. Supported account types: **Accounts in this organizational directory only** (single tenant). Redirect URI: platform **Web**, value `https://payroll-audit.novumsp.live/auth/microsoft/callback`. Register.
2. From Overview copy **Application (client) ID** to `ENTRA_CLIENT_ID` and **Directory (tenant) ID** to `ENTRA_TENANT_ID`.
3. Certificates & secrets, New client secret, 24 months. Copy the **Value** (not the Secret ID) to `ENTRA_CLIENT_SECRET` immediately; it is shown once. Put the expiry on the calendar.
4. API permissions: the defaults (`User.Read`, delegated) are enough; the app asks for `openid profile email`. Grant admin consent so people do not see a consent prompt.
5. The app admits only accounts issued by this tenant. The email on the access list must match the person's user principal name in lowercase (the `preferred_username` claim), which for Novum is the work email. A personal Microsoft account or a guest from another tenant is refused regardless of email domain.
6. Redeploy or trigger a redeploy after setting the three variables, then sign in at `/login`.

## 3. Gusto (the firm connection)

You already hold the app's client id and secret; they go in `GUSTO_CLIENT_ID` and `GUSTO_CLIENT_SECRET`.

1. In the Gusto developer portal, open the app and set the **redirect URI** to `https://payroll-audit.novumsp.live/auth/gusto/callback`. It must match exactly.
2. Scopes: read only. The system reads companies, employees and jobs (with compensations), pay schedules, locations, payrolls (with benefits, deductions and taxes), payroll blockers, company benefits, the benefits catalog, and tax requirements. It never requests a write scope and never submits payroll.
3. Environment: `GUSTO_API_BASE=https://api.gusto.com` for production. If Gusto has only approved the app for the demo environment so far, use `https://api.gusto-demo.com` and a demo company first; the code is the same.
4. After deploying with those variables, sign in as lead, open **Admin**, press **Connect Gusto**, and authorize with the firm account that is payroll admin on the client companies. Admin then shows the connection, when the token was last refreshed, and any error. Tokens are stored encrypted; access tokens last two hours and the system refreshes them itself.
5. The client's **Platform company id** under Admin is the Gusto company UUID. The hourly cycle pulls the next unprocessed payroll for every client with status live and a signed profile.

## 4. Box (reports out, documents in)

1. Box Developer Console, Create New App, **Custom App**, authentication method **Server Authentication (Client Credentials Grant)**. Name `Payroll QA`.
2. Configuration: App Access Level **App + Enterprise Access**. Application scopes: **Read all files and folders** and **Write all files and folders** (write is needed to upload the QA reports and the signed profile PDF; the code never deletes). Copy the client id and secret to `BOX_CLIENT_ID` and `BOX_CLIENT_SECRET`. Copy the **Enterprise ID** (General Settings) to `BOX_SUBJECT_ID`; `BOX_SUBJECT_TYPE=enterprise`.
3. Box Admin Console, Apps, Custom Apps Manager, **Authorize** the app with its client id. Without this step every call fails with invalid grant credentials.
4. Copy the app's **service account email** (it looks like `AutomationUser_...@boxdevedition.com`, under General Settings) and invite it as a collaborator with the **Editor** role on each client's payroll folder. Viewer cannot upload.
5. Folder per client, and its id goes in the client's **Box folder id** under Admin (the number at the end of the folder URL). Recommended layout, which the profile builder reads two levels deep:
   ```
   <Client>/Payroll QA/
     Board Resolutions/      housing designations
     Benefits/               plan summaries, enrollment forms
     Offer Letters/          offer letters, comp memos
     PTO Policy/
     payroll-exports/        Rippling only: <period end>/register.csv and roster.csv
   ```
   QA reports and the signed profile PDF are written to the folder root as `Payroll QA <period end> attempt N.{md,json,pdf}` and `Payroll Profile signed <date>.pdf`.

## 5. JotForm (the change ledger)

1. For each payroll change form, find every field's **unique name**: open the form in the builder, click the field, Properties, Advanced, Field Details; the unique name looks like `q3_employee`. Write down the client field, the employee field, the effective date field, the submitter email field, and the fields carrying the request's amounts and dates.
2. Build `JOTFORM_FORMS` as a JSON array in the shape of `config/jotform-forms.example.json`: one entry per form with the form id, the request type, those keys, and a `fields` map from the payload names the example uses (`newRate`, `hireDate`, `terminationDate`, `payoutAccruedTimeOff`, `annualAmount`, `perPeriodAmount`, `resolutionDate`, `planId`, `employeeDeduction`, `employerContribution`, `policyName`, `accrualRateHours`, `capHours`, `earningType`, `amount`, `description`, `deductionName`, `payFrequency`, `payType`, `rate`, `name`, `workState`) to the form's unique names. New-hire forms have no employee field.
3. The client field must carry the client's exact legal name as entered under Admin (or the client id). A dropdown of legal names on the form avoids typos. The employee field must carry the employee's name exactly as the platform has it, or the platform employee id.
4. In each form: Settings, Integrations, **Webhooks**, add `https://payroll-audit.novumsp.live/api/webhooks/jotform/<JOTFORM_WEBHOOK_SECRET>`.
5. Send one test submission per form. The client page shows it under "Change requests awaiting application"; the audit log records `jotform.received`, or `jotform.rejected` with the reason when a field was blank, a date impossible, or the client or employee unknown. JotForm can resend a submission from its webhook history after you fix the form.

## 6. Slack (optional; without it every message sits in the dashboard inbox)

1. api.slack.com/apps, Create New App, from scratch, in Novum's workspace. OAuth & Permissions, bot token scopes: `chat:write`, `chat:write.public`. Install to workspace; copy the **Bot User OAuth Token** to `SLACK_BOT_TOKEN`.
2. Create or pick the pod channel, invite the bot, copy the channel id (channel details, bottom) to `SLACK_POD_CHANNEL`.
3. For each specialist and the lead, copy their Slack member id (profile, three dots, Copy member ID) into their row under Admin. Messages to a person go to that id; a person without one falls back to the pod channel.

Messages go to Novum people only. The client reminder and the client preview are delivered to the specialist as text to send; nothing is ever posted to a client.

## 7. Anthropic (optional; document reading in the profile builder)

Create a key at console.anthropic.com and set `ANTHROPIC_API_KEY`. Without it the builder still drafts from the platform and lists the Box documents, but does not read them.

## 8. Rippling (export mode)

Until partner API access is granted, each Rippling client runs on scheduled exports. In Rippling, schedule two report exports per pay period into the client's Box folder under `payroll-exports/<period end date>/`: `register.csv` (columns `Employee ID, Employee Name, Line Type, Line Name, Amount, Hours, Employer Amount, Tax Treatment`; Line Type is Earning, Deduction, Tax or Net) and `roster.csv` (`Employee ID, Pay Type, Rate, Work State, PTO Balance (hours), YTD Housing Allowance`). Under Admin keep the client's next period start, end and pay date current; the cycle reads them because an export carries no calendar.

## 9. Proving it works, in order

1. `https://payroll-audit.novumsp.live/api/health` while signed in: database ok, and true for each integration you configured.
2. Admin: Gusto shows connected. Add the first pilot client with its Gusto company UUID, Box folder id, specialist, contact, registered states; status onboarding.
3. Client page, Payroll Profile, **Draft from gusto and Box**. Resolve every question. Sign. The profile PDF appears in the Box folder and the client moves to live.
4. Force a tick instead of waiting for the hour: `curl -H "Authorization: Bearer <CRON_SECRET>" https://payroll-audit.novumsp.live/api/cron/cycle`. The response lists the client, its run id, and the stages that ran. The queue now shows the run.
5. Open the run and press **Run QA now**. Three files land in Box; exceptions appear with expected, actual and source.
6. Run the pilot in parallel with the pod's manual process for two cycles before declaring it live.
