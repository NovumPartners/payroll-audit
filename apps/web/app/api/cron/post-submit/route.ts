import { NextResponse, type NextRequest } from "next/server";
import { postSubmitCompare } from "@payroll-qa/jobs";
import { buildDeps } from "@/lib/deps";
import { cronAuthorized } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const results = await postSubmitCompare(await buildDeps());
  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
