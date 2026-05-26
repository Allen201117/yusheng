import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getPersonaForUser, getMemoryById, insertMemory, listMemories, deleteMemory } from "@/lib/db";
import { embed } from "@/lib/embedding";
import { requireAuth } from "@/lib/guard";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const personaId = req.nextUrl.searchParams.get("personaId") || "";
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });

  // 越权检查
  const p = getPersonaForUser(personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  return NextResponse.json({ memories: listMemories(personaId) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: { personaId?: string; content?: string; contents?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const personaId = (body.personaId || "").trim();
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });

  const p = getPersonaForUser(personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  const contents: string[] = [];
  if (body.content) contents.push(body.content.trim());
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      const t = (c || "").trim();
      if (t) contents.push(t);
    }
  }
  if (contents.length === 0) {
    return NextResponse.json({ error: "至少提供 content 或 contents" }, { status: 400 });
  }
  if (contents.length > 50) {
    return NextResponse.json({ error: "一次最多 50 条" }, { status: 400 });
  }

  try {
    const vectors = await embed(contents);
    const inserted: { id: string; content: string }[] = [];
    for (let i = 0; i < contents.length; i++) {
      const id = randomUUID();
      insertMemory({ id, personaId, content: contents[i], embedding: vectors[i] });
      inserted.push({ id, content: contents[i] });
    }
    return NextResponse.json({ ok: true, inserted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  // 先查 memory 属于哪个 persona，再校验该 persona 属于当前用户
  const mem = getMemoryById(id);
  if (!mem) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
  const p = getPersonaForUser(mem.personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "无权删除" }, { status: 403 });

  deleteMemory(id);
  return NextResponse.json({ ok: true });
}
