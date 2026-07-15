import { NextRequest, NextResponse } from "next/server";

type OriginEnvironment = Record<string, string | undefined>;

function normalizeOrigin(value: string, defaultProtocol?: "https:"): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `${defaultProtocol}//${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function trustedOrigins(req: NextRequest, env: OriginEnvironment): Set<string> {
  const origins = new Set<string>();
  const configured = [
    env.APP_ORIGIN,
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.VERCEL_BRANCH_URL,
    env.VERCEL_URL,
  ];
  for (const value of configured) {
    if (!value) continue;
    const origin = normalizeOrigin(value, "https:");
    if (origin) origins.add(origin);
  }
  if (env.NODE_ENV !== "production") origins.add(req.nextUrl.origin);
  return origins;
}

export function requireSameOrigin(
  req: NextRequest,
  env: OriginEnvironment = process.env,
): NextResponse | null {
  const originHeader = req.headers.get("origin");
  if (!originHeader) {
    return NextResponse.json(
      { error: "缺少请求来源", code: "ORIGIN_REQUIRED" },
      { status: 403 },
    );
  }

  const origins = trustedOrigins(req, env);
  if (origins.size === 0) {
    return NextResponse.json(
      { error: "服务未配置可信来源", code: "ORIGIN_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const requestOrigin = normalizeOrigin(originHeader);
  if (!requestOrigin || !origins.has(requestOrigin)) {
    return NextResponse.json(
      { error: "请求来源不受信任", code: "ORIGIN_MISMATCH" },
      { status: 403 },
    );
  }
  return null;
}
