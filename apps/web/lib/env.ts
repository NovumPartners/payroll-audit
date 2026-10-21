/** Environment, read once, with the names documented in .env.example. Secrets never leave this module as logs. */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  get databaseUrl() {
    return req("DATABASE_URL");
  },
  get appSecret() {
    const s = req("APP_SECRET");
    if (s.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
    return s;
  },
  get baseUrl() {
    return (process.env.APP_BASE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")).replace(/\/$/, "");
  },
  get entra() {
    return { tenantId: req("ENTRA_TENANT_ID"), clientId: req("ENTRA_CLIENT_ID"), clientSecret: req("ENTRA_CLIENT_SECRET") };
  },
  cronSecret: () => process.env.CRON_SECRET,
  jotformSecret: () => process.env.JOTFORM_WEBHOOK_SECRET,
  jotformForms: () => process.env.JOTFORM_FORMS,
  gusto: () => (process.env.GUSTO_ACCESS_TOKEN ? { accessToken: process.env.GUSTO_ACCESS_TOKEN, apiBase: process.env.GUSTO_API_BASE, apiVersion: process.env.GUSTO_API_VERSION } : undefined),
  box: () =>
    process.env.BOX_CLIENT_ID && process.env.BOX_CLIENT_SECRET && process.env.BOX_SUBJECT_ID
      ? { clientId: process.env.BOX_CLIENT_ID, clientSecret: process.env.BOX_CLIENT_SECRET, subjectId: process.env.BOX_SUBJECT_ID, subjectType: (process.env.BOX_SUBJECT_TYPE as "enterprise" | "user" | undefined) ?? "enterprise" }
      : undefined,
  slackBotToken: () => process.env.SLACK_BOT_TOKEN,
  slackPodChannel: () => process.env.SLACK_POD_CHANNEL,
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY,
  isProduction: () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production",
};
