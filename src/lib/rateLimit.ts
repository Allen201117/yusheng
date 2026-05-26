/**
 * TTS 速率限制器（Slice 3）
 *
 * 内存中的滑动窗口计数器，按 userId 隔离。
 * 重启后清零（Slice 3 不持久化，够用）。
 *
 * 默认：每用户每天 50 次 TTS 调用。
 */

const LIMIT_RAW = parseInt(process.env.TTS_DAILY_LIMIT || "50", 10);
const LIMIT = Number.isFinite(LIMIT_RAW) && LIMIT_RAW > 0 ? LIMIT_RAW : 50;
const WINDOW_MS = 24 * 3600 * 1000; // 1 day

type Bucket = {
  count: number;
  windowStart: number; // ms
};

const buckets = new Map<string, Bucket>();

export function checkTtsRateLimit(userId: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let b = buckets.get(userId);

  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(userId, b);
  }

  if (b.count >= LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: b.windowStart + WINDOW_MS,
    };
  }

  b.count += 1;
  return {
    allowed: true,
    remaining: LIMIT - b.count,
    resetAt: b.windowStart + WINDOW_MS,
  };
}
