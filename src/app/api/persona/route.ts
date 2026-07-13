import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/guard";
import { getRepository } from "@/lib/storage/repository";
import { getVoiceObjectStore } from "@/lib/storage/voiceObjectStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ personas: await getRepository().listPersonas(auth.userId) });
}

export async function POST(req: NextRequest) {
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

  const voice = await getVoiceObjectStore().get(voiceId, auth.userId);
  if (!voice) return NextResponse.json({ error: "voiceId 不存在或不属于你" }, { status: 404 });

  const persona = await getRepository().createPersona({
    id: randomUUID(),
    userId: auth.userId,
    name,
    relation,
    voiceId,
    personaDesc,
  });
  return NextResponse.json({ ok: true, persona });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  const repository = getRepository();
  const persona = await repository.getPersonaForUser(id, auth.userId);
  if (!persona) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  const voiceId = persona.voiceId;

  // 先删 persona（memories/messages 级联删除）
  await repository.deletePersona(id, auth.userId);

  // 仅当当前用户没有其他 persona 复用该 voice 时才清参考音频
  if (await repository.countPersonasUsingVoice(voiceId, auth.userId) === 0) {
    await getVoiceObjectStore().delete(voiceId, auth.userId);
  }

  return NextResponse.json({ ok: true });
}
