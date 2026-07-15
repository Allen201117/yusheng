import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/guard";
import { requireSameOrigin } from "@/lib/sensitiveWriteGuard";
import { getRepository } from "@/lib/storage/repository";
import { executePersonaCreation } from "@/lib/personaCreation";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ personas: await getRepository().listPersonas(auth.userId) });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: { name?: string; relation?: string; voiceId?: string; personaDesc?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const name = (body.name || "").trim();
  const relation = (body.relation || "").trim();
  const voiceId = (body.voiceId || "").trim();
  const personaDesc = (body.personaDesc || "").trim();

  if (!name) return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  if (!relation) return NextResponse.json({ error: "缺少 relation" }, { status: 400 });
  if (!voiceId) return NextResponse.json({ error: "缺少 voiceId" }, { status: 400 });

  const result = await executePersonaCreation({
    id: randomUUID(),
    userId: auth.userId,
    name,
    relation,
    voiceId,
    personaDesc,
  }, getRepository);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  const repository = getRepository();
  const persona = await repository.getPersonaForUser(id, auth.userId);
  if (!persona) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  // 删除人物不会顺带撤回声音授权；声音撤回应走可审计、可重试的统一流程。
  await repository.deletePersona(id, auth.userId);
  return NextResponse.json({ ok: true });
}
