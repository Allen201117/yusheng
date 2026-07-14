import { NextRequest } from "next/server";
import { createPersonaKnowledgeHandlers } from "@/lib/personaKnowledgeRoute";

export const runtime = "nodejs";

const handlers = createPersonaKnowledgeHandlers();

export async function GET(req: NextRequest) {
  return handlers.GET(req);
}

export async function POST(req: NextRequest) {
  return handlers.POST(req);
}

export async function PATCH(req: NextRequest) {
  return handlers.PATCH(req);
}

export async function DELETE(req: NextRequest) {
  return handlers.DELETE(req);
}
