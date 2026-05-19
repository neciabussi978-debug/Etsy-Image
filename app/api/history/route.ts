import { NextResponse } from "next/server";
import { deleteExpiredFailedGenerations, listGenerations } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  deleteExpiredFailedGenerations();
  const rows = listGenerations(200);
  return NextResponse.json({ items: rows });
}
