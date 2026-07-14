import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { embed } from "@/lib/embedding";
import { requireAuth } from "@/lib/guard";
import { logger } from "@/lib/logger";
import { isMemoryPostBody, parseMemoryContents } from "@/lib/memoryRoute";
import { getRepository } from "@/lib/storage/repository";
import { sha256Hex } from "@/lib/storage/checksum";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const personaId = req.nextUrl.searchParams.get("personaId") || "";
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });

  // 越权检查
  const repository = getRepository();
  const p = await repository.getPersonaForUser(personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  return NextResponse.json({ memories: await repository.listMemories(personaId) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!isMemoryPostBody(body)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const personaId = typeof body.personaId === "string" ? body.personaId.trim() : "";
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });

  const parsedContents = parseMemoryContents(body);
  if ("error" in parsedContents) {
    return NextResponse.json({ error: parsedContents.error }, { status: 400 });
  }
  const { contents } = parsedContents;
  if (contents.length === 0) {
    return NextResponse.json({ error: "至少提供 content 或 contents" }, { status: 400 });
  }
  if (contents.length > 50) {
    return NextResponse.json({ error: "一次最多 50 条" }, { status: 400 });
  }

  const repository = getRepository();
  const p = await repository.getPersonaForUser(personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  try {
    const vectors = await embed(contents);
    if (vectors.length !== contents.length) throw new Error("embedding_count_mismatch");
    const inputs = contents.map((content, i) => {
      const id = randomUUID();
      const sourceId = randomUUID();
      return {
        id,
        personaId,
        content,
        embedding: vectors[i],
        createdBy: auth.userId,
        sourceId,
        checksumAlgorithm: "sha256" as const,
        checksum: sha256Hex(Buffer.from(content, "utf8")),
      };
    });
    await repository.insertMemories(inputs);
    const inserted = inputs.map(({ id, content }) => ({ id, content }));
    return NextResponse.json({ ok: true, inserted });
  } catch (err) {
    logger.error("memory_insert_failed", {
      personaId,
      userId: auth.userId,
      count: contents.length,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
    return NextResponse.json({ error: "记忆保存失败，请稍后重试" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  // 先查 memory 属于哪个 persona，再校验该 persona 属于当前用户
  const repository = getRepository();
  const mem = await repository.getMemoryById(id);
  if (!mem) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
  const p = await repository.getPersonaForUser(mem.personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "无权删除" }, { status: 403 });

  if (!await repository.deleteMemory(id)) {
    return NextResponse.json({ error: "记忆状态已变更" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
