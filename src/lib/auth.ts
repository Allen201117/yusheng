/**
 * 简单认证模块（Slice 3）
 *
 * MVP 阶段用共享密码 + cookie session，不做飞书 OAuth。
 * 原因：飞书 OAuth 需要创建企业自建应用、审批、配置回调 URL，
 * 这些前置步骤会拖慢闭环验收。
 *
 * 架构上留好了替换口：
 *   - session 里存的 userId 在换飞书 OAuth 后变成 open_id，其余代码零改动
 *   - AUTH_MODE 环境变量预留了 "feishu" 值，未来切换
 *
 * 使用方式：
 *   1. 在 .env.local 里设 ACCESS_PASSWORD=你想设的密码
 *   2. 用户首次访问 → 跳登录页 → 输密码 → 设 cookie → 放行
 *   3. cookie 里存 { userId, expiresAt }，签名防篡改
 */

import { cookies } from "next/headers";

const AUTH_MODE = process.env.AUTH_MODE || "password";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const COOKIE_NAME = "yusheng_session";
const SESSION_SECRET = process.env.SESSION_SECRET || "yusheng-v2-change-me-in-prod";
const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 days

// 生产环境安全门禁：首次解析 session 时检测默认 secret，防止 session 伪造
// 不放在模块顶层：next build 时也会加载模块，但 NEXT_PHASE 表示 build 阶段
let sessionSecretChecked = false;
function assertSessionSecretSafe() {
  if (sessionSecretChecked) return;
  sessionSecretChecked = true;
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.NEXT_PHASE &&
    (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "yusheng-v2-change-me-in-prod")
  ) {
    throw new Error(
      "SESSION_SECRET 使用了默认值，生产环境必须设置 SESSION_SECRET 环境变量。"
    );
  }
}

// ---- 简单签名：HMAC-SHA256 ----
async function sign(payload: string): Promise<string> {
  assertSessionSecretSafe();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("base64url");
}

async function verify(payload: string, signature: string): Promise<boolean> {
  const expected = await sign(payload);
  return expected === signature;
}

// ---- Session 对象 ----
export type Session = {
  userId: string; // 密码模式下是 "user"，飞书模式下是 open_id
  expiresAt: number; // unix 秒
};

export async function createSession(userId: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = JSON.stringify({ userId, expiresAt });
  const signature = await sign(payload);
  // cookie 值 = base64(payload) + "." + signature
  const token = Buffer.from(payload).toString("base64url") + "." + signature;
  return token;
}

export async function parseSession(token: string): Promise<Session | null> {
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString("utf-8");
  if (!(await verify(payload, signature))) return null;
  try {
    const s = JSON.parse(payload) as Session;
    if (s.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}

// ---- 从请求 cookie 取当前 session ----
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return parseSession(token);
}

// ---- 验证密码 ----
export function verifyPassword(input: string): boolean {
  if (!ACCESS_PASSWORD) return false; // 未设密码则拒绝一切
  return input === ACCESS_PASSWORD;
}

// ---- cookie 设置参数 ----
export function sessionCookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  };
}

// ---- 判断是否需要鉴权 ----
export function isAuthConfigured(): boolean {
  // 仅当显式配置了 ACCESS_PASSWORD 时才要求登录
  // 不设密码 = 免登开放模式（部署默认状态）
  return ACCESS_PASSWORD.length > 0;
}
