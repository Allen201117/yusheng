type MemoryPostBody = { personaId?: unknown; content?: unknown; contents?: unknown };

const MAX_MEMORY_CONTENT_LENGTH = 20_000;
const MAX_MEMORY_BATCH_TEXT_LENGTH = 300_000;
const UNSAFE_BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function isMemoryPostBody(value: unknown): value is MemoryPostBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMemoryContents(body: unknown): { contents: string[] } | { error: string } {
  if (!isMemoryPostBody(body)) return { error: "请求体必须是 JSON 对象" };
  const contents: string[] = [];
  if (body.content !== undefined && typeof body.content !== "string") {
    return { error: "content 必须是字符串" };
  }
  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (content.length > MAX_MEMORY_CONTENT_LENGTH) return { error: "content 过长" };
    if (UNSAFE_BODY_CONTROL.test(content)) return { error: "content 包含不允许的控制字符" };
    if (content) contents.push(content);
  }
  if (body.contents !== undefined && !Array.isArray(body.contents)) {
    return { error: "contents 必须是字符串数组" };
  }
  if (Array.isArray(body.contents)) {
    for (const item of body.contents) {
      if (typeof item !== "string") return { error: "contents 每一项都必须是字符串" };
      const content = item.trim();
      if (content.length > MAX_MEMORY_CONTENT_LENGTH) return { error: "contents 单项过长" };
      if (UNSAFE_BODY_CONTROL.test(content)) return { error: "contents 包含不允许的控制字符" };
      if (content) contents.push(content);
    }
  }
  if (contents.reduce((total, content) => total + content.length, 0) > MAX_MEMORY_BATCH_TEXT_LENGTH) {
    return { error: "contents 总文本过长" };
  }
  return { contents };
}
