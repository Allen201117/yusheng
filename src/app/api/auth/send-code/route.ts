import { NextRequest, NextResponse } from "next/server";
import { createVerificationCode } from "@/lib/db";
import { sendEmailCode, sendSmsCode } from "@/lib/email";

export const runtime = "nodejs";

/**
 * POST /api/auth/send-code
 *   { email: "a@b.com" }  或  { phone: "13800138000" }
 */
const lastSent = new Map<string, number>();

export async function POST(req: NextRequest) {
  let body: { email?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const phone = (body.phone || "").trim().replace(/\s/g, "");

  // 邮箱通道
  if (email) {
    if (!email.includes("@")) {
      return NextResponse.json({ error: "请输入有效的邮箱" }, { status: 400 });
    }
    return sendAndRespond("email", email);
  }

  // 手机号通道
  if (phone) {
    if (!/^1\d{10}$/.test(phone)) {
      return NextResponse.json({ error: "请输入有效的 11 位手机号" }, { status: 400 });
    }
    return sendAndRespond("phone", phone);
  }

  return NextResponse.json({ error: "请输入邮箱或手机号" }, { status: 400 });
}

async function sendAndRespond(
  type: "email" | "phone",
  target: string,
) {
  // 60 秒限流
  const last = lastSent.get(target) || 0;
  const now = Date.now();
  if (now - last < 60_000) {
    const remain = Math.ceil((60_000 - (now - last)) / 1000);
    return NextResponse.json({ error: `请 ${remain} 秒后再试` }, { status: 429 });
  }
  lastSent.set(target, now);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await createVerificationCode(
    type === "email" ? { email: target } : { phone: target },
    code,
    5,
  );

  const result = type === "email"
    ? await sendEmailCode(target, code)
    : await sendSmsCode(target, code);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || "发送失败" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
