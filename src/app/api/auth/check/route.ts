import { NextResponse } from "next/server";
import { getSession, isAuthConfigured } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/auth/check
 * 客户端 AuthGuard 用来检测当前 cookie 是否有效
 * 未配置密码时直接放行
 */
export async function GET() {
  if (!isAuthConfigured()) {
    return NextResponse.json({ ok: true, userId: "__dev__" });
  }
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, userId: session.userId });
}
