import {
  synthesizeWithClonedVoice,
  type CosyVoiceCloneInput,
} from "./cosyvoice";
import { stableProviderErrorCode } from "./providerErrors";
import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type { AppRepository } from "./storage/types";
import {
  resolveVoiceSynthesisSource,
  type VoiceSynthesisSource,
} from "./voiceSynthesisSource";
import type { SpeechControls } from "./speechPlanning";

type Synthesize = (input: CosyVoiceCloneInput) => Promise<Buffer>;

type BaseSynthesisInput = {
  voiceId: string;
  userId: string;
  text: string;
  speech?: SpeechControls;
  store: VoiceObjectStore;
  repository: AppRepository;
  synthesize?: Synthesize;
};

export type StoredVoiceSynthesisResult = {
  audio: Buffer;
  source: "preset" | "dynamic";
  fellBack: boolean;
};

function isStalePresetError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = Number((error as { status?: unknown }).status);
  return status === 400 || status === 404;
}

function dynamicInput(
  source: Extract<VoiceSynthesisSource, { mode: "dynamic" }>,
  input: BaseSynthesisInput,
): CosyVoiceCloneInput {
  return {
    text: input.text,
    referenceAudioBase64: source.body.toString("base64"),
    referenceMime: source.meta.mimeType || "audio/wav",
    referenceText: source.meta.promptText,
    responseFormat: "mp3",
    speech: input.speech,
  };
}

export async function synthesizeResolvedVoice(
  input: BaseSynthesisInput & { source: VoiceSynthesisSource },
): Promise<StoredVoiceSynthesisResult> {
  const synthesize = input.synthesize || synthesizeWithClonedVoice;
  if (input.source.mode === "dynamic") {
    return {
      audio: await synthesize(dynamicInput(input.source, input)),
      source: "dynamic",
      fellBack: false,
    };
  }

  try {
    return {
      audio: await synthesize({
        text: input.text,
        presetVoiceId: input.source.presetVoiceId,
        responseFormat: "mp3",
        speech: input.speech,
      }),
      source: "preset",
      fellBack: false,
    };
  } catch (error) {
    if (!isStalePresetError(error)) throw error;
    await input.repository.updateVoiceProviderState(input.voiceId, input.userId, {
      status: "failed",
      providerVoiceId: input.source.presetVoiceId,
      errorCode: stableProviderErrorCode(error),
    });
    const dynamic = await input.store.get(input.voiceId, input.userId);
    if (!dynamic) throw error;
    return {
      audio: await synthesize(dynamicInput({ mode: "dynamic", ...dynamic }, input)),
      source: "dynamic",
      fellBack: true,
    };
  }
}

export async function synthesizeStoredVoice(
  input: BaseSynthesisInput,
): Promise<StoredVoiceSynthesisResult> {
  const source = await resolveVoiceSynthesisSource(input.store, input.voiceId, input.userId);
  if (!source) throw new Error("voice source unavailable");
  return synthesizeResolvedVoice({ ...input, source });
}
