import { checkTtsUsage } from "@/lib/db";
const configured = Number.parseInt(process.env.TTS_DAILY_LIMIT || "50", 10);
const limit = Number.isFinite(configured) && configured > 0 ? configured : 50;
export function checkTtsRateLimit(userId: string) { return checkTtsUsage(userId, limit); }
