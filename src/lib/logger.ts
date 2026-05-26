/**
 * 结构化日志
 *
 * 写入 data/logs/yusheng-{YYYY-MM-DD}.log
 * 格式：JSON 每行一条，方便 grep / jq
 *
 * 用法：
 *   import { logger } from "@/lib/logger";
 *   logger.error("tts_failed", { voiceId, err: err.message });
 *   logger.info("memory_saved", { count: 5 });
 */

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const LOG_DIR = path.join(DATA_DIR, "logs");

type Level = "info" | "warn" | "error";

type LogEntry = {
  ts: string;
  level: Level;
  event: string;
  [key: string]: unknown;
};

function write(level: Level, event: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry);

  // 同时输出到 stdout（方便 docker logs 看）和文件
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  // 写文件（不阻塞主流程）
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `yusheng-${date}.log`);
    fs.appendFileSync(file, line + "\n");
  } catch {
    // 日志写入失败不要把主流程搞崩
  }
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};
