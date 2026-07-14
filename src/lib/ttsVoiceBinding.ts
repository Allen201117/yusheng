import type { AppRepository } from "./storage/types";

export type TtsVoiceBindingResult =
  | { status: "resolved"; voiceId: string }
  | { status: "persona_not_found" }
  | { status: "voice_required" };

function normalizedId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveTtsVoiceId(input: {
  requestedVoiceId: unknown;
  personaId: unknown;
  userId: string;
  repository: AppRepository;
}): Promise<TtsVoiceBindingResult> {
  const requestedVoiceId = normalizedId(input.requestedVoiceId);
  if (requestedVoiceId) return { status: "resolved", voiceId: requestedVoiceId };

  const personaId = normalizedId(input.personaId);
  if (!personaId) return { status: "voice_required" };
  const persona = await input.repository.getPersonaForUser(personaId, input.userId);
  if (!persona) return { status: "persona_not_found" };
  return { status: "resolved", voiceId: persona.voiceId };
}
