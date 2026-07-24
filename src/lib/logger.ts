type Level = "info" | "warn" | "error";
function write(level: Level, event: string, data?: Record<string, unknown>) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}
export const logger = { info: (event: string, data?: Record<string, unknown>) => write("info", event, data), warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data), error: (event: string, data?: Record<string, unknown>) => write("error", event, data) };
