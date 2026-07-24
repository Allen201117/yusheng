import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, setUserPassword, verifyCode } from "@/lib/db";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";

/**
 * POST /api/auth/reset-password
 *   { email, code, password }
 *
 * 验证码正确 → 重置密码。5 分钟内有效。
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string; password?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON 格式错误" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const code = (body.code || "").trim();
  const password = (body.password || "").trim();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "请输入邮箱" }, { status: 400 });
  }
  if (!code || code.length !== 6) {
    return NextResponse.json({ error: "验证码为 6 位数字" }, { status: 400 });
  }
  if (!password || password.length < 4) {
    return NextResponse.json({ error: "新密码至少 4 位" }, { status: 400 });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });
  }

  if (!(await verifyCode({ email }, code))) {
    return NextResponse.json({ error: "验证码错误或已过期" }, { status: 401 });
  }

  const hash = await hashPassword(password);
  await setUserPassword(email, hash);

  return NextResponse.json({ ok: true });
}
