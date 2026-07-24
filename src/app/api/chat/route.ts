import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  getPersonaForUser,
  insertMessage,
  listMessages,
  loadMemoriesWithEmbeddings,
} from "@/lib/db";
import { embedOne, cosineSim } from "@/lib/embedding";
import { chatCompleteStream, ChatMessage } from "@/lib/llm";
import { requireAuth } from "@/lib/guard";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const TOP_K = 3;
const MIN_SCORE = 0.35;

const SELF_HARM_SIGNALS = [
  "自杀", "自残", "想死", "不想活", "活不下去", "结束自己", "了断",
];
const SAFETY_REPLY =
  "我听到了你的痛。你愿意把这段难受多讲一点吗？现在就联系一个真实的人也很重要——北京心理危机研究与干预中心 24 小时热线：010-82951332，或拨打 12320-5。";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: { personaId?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const personaId = (body.personaId || "").trim();
  const text = (body.text || "").trim();
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "缺少 text" }, { status: 400 });
  if (text.length > 500) return NextResponse.json({ error: "text 不得超过 500 字" }, { status: 400 });

  // 越权检查
  const persona = await getPersonaForUser(personaId, auth.userId);
  if (!persona) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  // 写入用户消息
  await insertMessage({ id: randomUUID(), personaId, role: "user", content: text });

  // 自伤词兜底 — 走 SSE 协议保持一致
  if (SELF_HARM_SIGNALS.some((w) => text.includes(w))) {
    await insertMessage({ id: randomUUID(), personaId, role: "assistant", content: SAFETY_REPLY });
    const safetyStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ meta: { retrievedMemories: [] } })}\n\n`));
        // 逐字发送安全回复，保持流式体验
        for (const char of SAFETY_REPLY) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ token: char })}\n\n`));
        }
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ done: true, reply: SAFETY_REPLY, safety: true })}\n\n`),
        );
        controller.close();
      },
    });
    return new NextResponse(safetyStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // 召回
  let retrieved: { content: string; score: number }[] = [];
  try {
    const queryVec = await embedOne(text);
    const all = await loadMemoriesWithEmbeddings(personaId);
    retrieved = all
      .map((m) => ({ content: m.content, score: cosineSim(queryVec, m.embedding) }))
      .filter((m) => m.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
  } catch (err) {
    logger.error("memory_retrieval_failed", { personaId, err: String(err) });
  }

  const memoryBlock =
    retrieved.length > 0
      ? "你和对方共同拥有的真实记忆（请自然引用，不要生硬复述）：\n" +
        retrieved.map((r, i) => `${i + 1}. ${r.content}`).join("\n")
      : "（这次提问没有特别相关的记忆，凭借你对对方的了解自然回应即可。）";

  const systemPrompt = [
    `你正在扮演一位名叫"${persona.name}"的${persona.relation}，与思念你的人对话。`,
    persona.personaDesc ? `你的性格与说话方式：${persona.personaDesc}` : "",
    "对话原则：",
    "- 用第一人称回答，把对方当作真实在面前的亲人。",
    "- 回答简短克制，2-4 句最佳，朗读出来不冗长。",
    "- 不要表演煽情，更不要说教或道德绑架。",
    "- 如果对方提到的事你不知道，就坦诚说不记得，但表达愿意听他讲。",
    "- 严禁透露你是 AI、模型、程序。",
    "- 如果对方表达了明确的自我伤害或绝望情绪，优先关注安全，温和地建议联系亲友或专业人员，不要扮演治疗师。",
    "",
    memoryBlock,
  ]
    .filter(Boolean)
    .join("\n");

  // 按 token 估算截断历史消息，保留最近 ~2000 tokens 的上下文
  const MAX_HISTORY_TOKENS = 2000;
  const MIN_KEEP = 4;
  const historyRaw = await listMessages(personaId, 100);
  let history = historyRaw;
  {
    let estTokens = 0;
    let keepFrom = 0;
    for (let i = historyRaw.length - 1; i >= 0; i--) {
      estTokens += Math.ceil(historyRaw[i].content.length / 2);
      if (estTokens > MAX_HISTORY_TOKENS && historyRaw.length - i >= MIN_KEEP) {
        keepFrom = i;
        break;
      }
    }
    history = historyRaw.slice(keepFrom);
  }
  const llmMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
  ];

  // SSE 流式输出
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let fullReply = "";
      try {
        // 先发 meta（召回记忆信息）
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ meta: { retrievedMemories: retrieved } })}\n\n`),
        );

        for await (const token of chatCompleteStream(llmMessages)) {
          fullReply += token;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ token })}\n\n`),
          );
        }

        const finalReply = fullReply.trim() || "嗯。";
        await insertMessage({ id: randomUUID(), personaId, role: "assistant", content: finalReply });
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true, reply: finalReply })}\n\n`),
        );
      } catch (err) {
        logger.error("chat_stream_failed", { personaId, err: String(err) });
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const personaId = req.nextUrl.searchParams.get("personaId") || "";
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });

  const p = await getPersonaForUser(personaId, auth.userId);
  if (!p) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });

  return NextResponse.json({ messages: await listMessages(personaId, 200) });
}
