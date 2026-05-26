import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  const opts = sessionCookieOptions();
  res.cookies.set({
    name: opts.name,
    value: "",
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    maxAge: 0,
    path: opts.path,
  });
  return res;
}
