import type {
  AppRepository,
  CreatePersonaInput,
  CreatePersonaWithApprovedVoiceResult,
} from "./storage/types";

type PersonaCreationRepository = Pick<AppRepository, "createPersonaWithApprovedVoice">;
type PersonaCreationRepositorySource =
  | PersonaCreationRepository
  | (() => PersonaCreationRepository);

type PersonaCreationResponse = {
  status: number;
  body: Record<string, unknown>;
};

export async function executePersonaCreation(
  input: CreatePersonaInput,
  repositorySource: PersonaCreationRepositorySource,
): Promise<PersonaCreationResponse> {
  try {
    const repository = typeof repositorySource === "function"
      ? repositorySource()
      : repositorySource;
    const result: CreatePersonaWithApprovedVoiceResult =
      await repository.createPersonaWithApprovedVoice(input);
    if (result.status === "voice_not_found") {
      return {
        status: 404,
        body: { error: "voiceId 不存在或不属于你", reasonCode: "VOICE_NOT_FOUND" },
      };
    }
    if (result.status === "authorization_denied") {
      return {
        status: 403,
        body: { error: "声音授权尚未通过", reasonCode: "VOICE_AUTHORIZATION_REQUIRED" },
      };
    }
    return { status: 200, body: { ok: true, persona: result.persona } };
  } catch {
    return {
      status: 500,
      body: { error: "人物创建失败，请稍后重试", reasonCode: "PERSONA_CREATE_FAILED" },
    };
  }
}
