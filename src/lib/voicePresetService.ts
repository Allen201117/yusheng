import { deletePresetVoice, uploadPresetVoice, type UploadPresetVoiceInput } from "./siliconFlowVoice";
import { stableProviderErrorCode } from "./providerErrors";
import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type { AppRepository, VoiceMeta } from "./storage/types";

type ProvisionDependencies = {
  repository: AppRepository;
  store: VoiceObjectStore;
  upload?: (input: UploadPresetVoiceInput) => Promise<string>;
};

type DeleteDependencies = {
  repository: AppRepository;
  store: VoiceObjectStore;
  removePreset?: (uri: string) => Promise<void>;
};

type ProvisionResult =
  | { status: "not_found"; meta: null }
  | { status: "ready"; meta: VoiceMeta }
  | { status: "failed"; meta: VoiceMeta | null; errorCode: string };

export async function provisionVoicePreset(
  voiceId: string,
  userId: string,
  dependencies: ProvisionDependencies,
): Promise<ProvisionResult> {
  const meta = await dependencies.store.getMeta(voiceId, userId);
  if (!meta) return { status: "not_found", meta: null };
  if (meta.providerVoiceStatus === "ready" && meta.providerVoiceId) {
    return { status: "ready", meta };
  }

  await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
    status: "pending",
    providerVoiceId: meta.providerVoiceId,
    errorCode: null,
  });
  const voice = await dependencies.store.get(voiceId, userId);
  if (!voice) {
    const errorCode = "private_audio_missing";
    const failed = await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
      status: "failed",
      providerVoiceId: meta.providerVoiceId,
      errorCode,
    });
    return { status: "failed", meta: failed, errorCode };
  }

  try {
    const upload = dependencies.upload || uploadPresetVoice;
    const uri = await upload({
      voiceId,
      audio: voice.body,
      mimeType: voice.meta.mimeType,
      promptText: voice.meta.promptText,
    });
    const ready = await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
      status: "ready",
      providerVoiceId: uri,
      errorCode: null,
    });
    if (!ready) return { status: "not_found", meta: null };
    return { status: "ready", meta: ready };
  } catch (error) {
    const errorCode = stableProviderErrorCode(error);
    const failed = await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
      status: "failed",
      providerVoiceId: meta.providerVoiceId,
      errorCode,
    });
    return { status: "failed", meta: failed, errorCode };
  }
}

export async function deleteVoiceEverywhere(
  voiceId: string,
  userId: string,
  dependencies: DeleteDependencies,
): Promise<boolean> {
  const meta = await dependencies.store.getMeta(voiceId, userId);
  if (!meta) return false;

  if (meta.providerVoiceId) {
    await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
      status: "deleting",
      providerVoiceId: meta.providerVoiceId,
      errorCode: null,
    });
    try {
      const removePreset = dependencies.removePreset || deletePresetVoice;
      await removePreset(meta.providerVoiceId);
    } catch (error) {
      await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
        status: "failed",
        providerVoiceId: meta.providerVoiceId,
        errorCode: stableProviderErrorCode(error),
      });
      throw new Error("provider preset deletion failed");
    }
    await dependencies.repository.updateVoiceProviderState(voiceId, userId, {
      status: "not_created",
      providerVoiceId: null,
      errorCode: null,
    });
  }

  return dependencies.store.delete(voiceId, userId);
}
