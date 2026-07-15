import { createPlaybackEventHandlers } from "@/lib/playbackEventRoute";

export const runtime = "nodejs";

export const { POST } = createPlaybackEventHandlers();
