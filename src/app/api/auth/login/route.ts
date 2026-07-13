import { NextRequest, NextResponse } from "next/server";
import { createSession, sessionCookieOptions } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { getRepository } from "@/lib/storage/repository";

export const runtime = "nodejs";

/**
 * POST /api/auth/login
 *
 * 邮箱 + 密码模式：
 *   { email, password }
 *
 * 首次登录（邮箱不存在）→ 自动注册 + 设置密码
 * 后续登录 → 验证密码
 * 如果用户没设密码（老验证码用户）→ 首次输入密码即设置
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = (body.password || "").trim();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "请输入有效的邮箱" }, { status: 400 });
  }
  if (!password || password.length < 4) {
    return NextResponse.json({ error: "密码至少 4 位" }, { status: 400 });
  }

  const repository = getRepository();
  let user = await repository.getUserByEmail(email);

  if (!user) {
    // 首次登录：自动注册
    const hash = await hashPassword(password);
    user = await repository.createUserByEmail(email, hash);
  } else if (!user.password) {
    // 老验证码用户首次设密码
    const hash = await hashPassword(password);
    await repository.setUserPassword(email, hash);
    user.password = hash;
  } else {
    // 验证密码
    const valid = await verifyPassword(user.password, password);
    if (!valid) {
      return NextResponse.json({ error: "密码错误" }, { status: 401 });
    }
  }

  const token = await createSession(user.id);
  const res = NextResponse.json({ ok: true, isNew: !user.password });
  setCookie(res, token);
  return res;
}

function setCookie(res: NextResponse, token: string) {
  const opts = sessionCookieOptions();
  res.cookies.set({
    name: opts.name, value: token,
    httpOnly: opts.httpOnly, secure: opts.secure,
    sameSite: opts.sameSite, maxAge: opts.maxAge, path: opts.path,
  });
}
