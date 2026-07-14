import { createTtsHandlers } from "@/lib/ttsRoute";

export const runtime = "nodejs";

export const { POST } = createTtsHandlers();
