import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Signed-in people only: which integrations are configured and whether the database answers. No secrets, no figures. */
export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  let database = "ok";
  try {
    await db().execute(sql`select 1`);
  } catch (err) {
    database = err instanceof Error ? err.message : "error";
  }
  return NextResponse.json({
    database,
    gusto: !!env.gusto(),
    box: !!env.box(),
    slack: !!env.slackBotToken(),
    jotform: !!env.jotformSecret() && !!env.jotformForms(),
    anthropic: !!env.anthropicApiKey(),
    cron: !!env.cronSecret(),
  });
}
