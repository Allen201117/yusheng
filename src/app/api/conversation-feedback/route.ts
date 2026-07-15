import { createConversationFeedbackHandlers } from "@/lib/conversationFeedbackRoute";

export const runtime = "nodejs";

export const { GET, POST } = createConversationFeedbackHandlers();
