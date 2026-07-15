import { deletePresetVoice, uploadPresetVoice, type UploadPresetVoiceInput } from "./siliconFlowVoice";
import { stableProviderErrorCode } from "./providerErrors";
import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type { AppRepository, VoiceMeta } from "./storage/types";

type ProvisionDependencies = {
  repository: AppRepository;
  store: VoiceObjectStore;
  upload?: (input: UploadPresetVoiceInput) => Promise<string>;
  removePreset?: (uri: string) => Promise<void>;
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

async function removeProviderPreset(
  voiceId: string,
  userId: string,
  providerVoiceId: string,
  dependencies: DeleteDependencies,
  failureMessage: string,
  generation?: number,
): Promise<void> {
  const claimed = generation === undefined
    ? await dependencies.repository.claimVoiceProviderOperation(voiceId, userId, "deleting")
    : null;
  const operationGeneration = generation ?? (claimed?.status === "claimed" ? claimed.generation : null);
  if (operationGeneration === null) throw new Error(failureMessage);
  try {
    const removePreset = dependencies.removePreset || deletePresetVoice;
    await removePreset(providerVoiceId);
  } catch (error) {
    const failed = await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, operationGeneration, {
      status: "failed",
      providerVoiceId,
      errorCode: stableProviderErrorCode(error),
    });
    if (!failed) {
      await dependencies.repository.settleSupersededVoiceProviderOperation(
        voiceId, userId, operationGeneration,
        { providerVoiceId, cleanupPending: true, errorCode: stableProviderErrorCode(error) },
      );
    }
    throw new Error(failureMessage);
  }
  const completed = await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, operationGeneration, {
    status: "not_created",
    providerVoiceId: null,
    errorCode: null,
  });
  if (!completed) {
    await dependencies.repository.settleSupersededVoiceProviderOperation(
      voiceId, userId, operationGeneration,
      { providerVoiceId: null, cleanupPending: false, errorCode: null },
    );
  }
}

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

  const claim = await dependencies.repository.claimVoiceProviderOperation(voiceId, userId, "pending");
  if (claim.status === "not_found") return { status: "not_found", meta: null };
  if (claim.status === "deletion_pending") {
    return { status: "failed", meta, errorCode: "voice_deletion_pending" };
  }
  if (claim.status !== "claimed") return { status: "not_found", meta: null };
  const generation = claim.generation;
  const voice = await dependencies.store.get(voiceId, userId);
  if (!voice) {
    const errorCode = "private_audio_missing";
    const failed = await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, generation, {
      status: "failed",
      providerVoiceId: meta.providerVoiceId,
      errorCode,
    });
    if (!failed) {
      await dependencies.repository.settleSupersededVoiceProviderOperation(
        voiceId,
        userId,
        generation,
        { providerVoiceId: null, cleanupPending: false, errorCode: null },
      );
    }
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
    const ready = await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, generation, {
      status: "ready",
      providerVoiceId: uri,
      errorCode: null,
    });
    if (!ready) {
      const removePreset = dependencies.removePreset || deletePresetVoice;
      try {
        await removePreset(uri);
        await dependencies.repository.settleSupersededVoiceProviderOperation(
          voiceId, userId, generation,
          { providerVoiceId: null, cleanupPending: false, errorCode: null },
        );
        return { status: "failed", meta: null, errorCode: "provider_operation_superseded" };
      } catch (cleanupError) {
        await dependencies.repository.settleSupersededVoiceProviderOperation(
          voiceId, userId, generation,
          {
            providerVoiceId: uri,
            cleanupPending: true,
            errorCode: stableProviderErrorCode(cleanupError),
          },
        );
        return { status: "failed", meta: null, errorCode: "provider_orphan_cleanup_pending" };
      }
    }
    return { status: "ready", meta: ready };
  } catch (error) {
    const errorCode = stableProviderErrorCode(error);
    const failed = await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, generation, {
      status: "failed",
      providerVoiceId: meta.providerVoiceId,
      errorCode,
    });
    if (!failed) {
      await dependencies.repository.settleSupersededVoiceProviderOperation(
        voiceId, userId, generation,
        { providerVoiceId: null, cleanupPending: false, errorCode: null },
      );
    }
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
    await removeProviderPreset(
      voiceId,
      userId,
      meta.providerVoiceId,
      dependencies,
      "provider preset deletion failed",
    );
  }

  return dependencies.store.delete(voiceId, userId);
}

export async function revokeVoicePreset(
  voiceId: string,
  userId: string,
  dependencies: DeleteDependencies,
): Promise<"not_found" | "not_configured" | "revoked"> {
  const meta = await dependencies.store.getMeta(voiceId, userId);
  if (!meta) return "not_found";
  const claim = await dependencies.repository.claimVoiceProviderOperation(voiceId, userId, "deleting");
  if (claim.status === "not_found") return "not_found";
  if (claim.status === "deletion_pending") return "not_configured";
  if (claim.status !== "claimed") return "not_found";
  const providerVoiceId = claim.meta.providerVoiceId;
  if (!providerVoiceId) {
    await dependencies.repository.completeVoiceProviderOperation(voiceId, userId, claim.generation, {
      status: "not_created", providerVoiceId: null, errorCode: null,
    });
    return "not_configured";
  }

  await removeProviderPreset(
    voiceId,
    userId,
    providerVoiceId,
    dependencies,
    "provider preset revocation failed",
    claim.generation,
  );
  return "revoked";
}
