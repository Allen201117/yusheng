/**
 * API 路由通用守卫：鉴权 + 取 userId
 *
 * 用法：在 route handler 里调用 requireAuth(req)，
 * 返回 { userId } 或 { error: Response }。
 * 如果返回了 error，直接 return error 即可。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, isAuthConfigured } from "@/lib/auth";

export type AuthResult =
  | { userId: string }
  | { error: NextResponse };

export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  // 如果没配密码，跳过鉴权（开发模式兼容）
  if (!isAuthConfigured()) {
    return { userId: "__dev__" };
  }
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json({ error: "未登录", code: "UNAUTHORIZED" }, { status: 401 }),
    };
  }
  return { userId: session.userId };
}
