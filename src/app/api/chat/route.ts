import { createChatHandlers } from "@/lib/chatRoute";
export const runtime = "nodejs";
const handlers = createChatHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
