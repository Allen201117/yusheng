import { randomUUID } from "node:crypto";
import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type {
  AppRepository,
  VoiceAuthorization,
  VoiceAuthorizationAttestation,
} from "./storage/types";
import {
  evaluateVoiceAuthorization,
  VOICE_AUTHORIZATION_NOTICE_VERSION,
} from "./voiceAuthorizationPolicy";
import {
  provisionVoicePreset,
  revokeVoicePreset,
} from "./voicePresetService";
import {
  createPresetVoiceName,
  deletePresetVoice,
  listPresetVoices,
  type ListedPresetVoice,
} from "./siliconFlowVoice";
import { stableProviderErrorCode } from "./providerErrors";

type Dependencies = {
  repository: AppRepository;
  store: VoiceObjectStore;
};

type SubmitDependencies = Dependencies & {
  provision?: typeof provisionVoicePreset;
  revokePreset?: typeof revokeVoicePreset;
};

type RevokeDependencies = Dependencies & {
  removePreset?: (uri: string) => Promise<void>;
  listPresets?: () => Promise<ListedPresetVoice[]>;
};

type ReviewDependencies = SubmitDependencies & {
  nowIso?: () => string;
};

export type SubmitVoiceAuthorizationInput = VoiceAuthorizationAttestation & {
  voiceId: string;
  userId: string;
};

async function provisionWhileApproved(
  authorization: VoiceAuthorization,
  dependencies: SubmitDependencies,
): Promise<Awaited<ReturnType<typeof provisionVoicePreset>>> {
  const provision = dependencies.provision || provisionVoicePreset;
  const preset = await provision(authorization.voiceId, authorization.userId, dependencies);
  let current: VoiceAuthorization | null = null;
  let recheckFailed = false;
  try {
    current = await dependencies.repository.getCurrentVoiceAuthorization(
      authorization.voiceId,
      authorization.userId,
    );
  } catch {
    recheckFailed = true;
  }
  if (!recheckFailed && current?.id === authorization.id && current.status === "approved") {
    return preset;
  }

  let cleanupPending = false;
  try {
    const revokePreset = dependencies.revokePreset || revokeVoicePreset;
    await revokePreset(authorization.voiceId, authorization.userId, dependencies);
  } catch {
    cleanupPending = true;
  }
  return {
    status: "failed",
    meta: preset.meta,
    errorCode: cleanupPending
      ? "authorization_cleanup_pending"
      : recheckFailed
        ? "authorization_recheck_failed"
        : "authorization_changed_during_provision",
  };
}

export async function submitVoiceAuthorization(
  input: SubmitVoiceAuthorizationInput,
  dependencies: SubmitDependencies,
) {
  const deletion = await dependencies.repository.getActiveVoiceDeletionJob?.(
    input.voiceId,
    input.userId,
  );
  if (deletion) return { status: "rejected" as const, reasonCode: "voice_deletion_pending" };
  const voice = await dependencies.store.getMeta(input.voiceId, input.userId);
  if (!voice) return { status: "not_found" as const };

  const current = await dependencies.repository.getCurrentVoiceAuthorization(
    input.voiceId,
    input.userId,
  );
  if (current) {
    if (current.speakerStatus !== input.speakerStatus || current.basis !== input.basis) {
      return { status: "rejected" as const, reasonCode: "authorization_classification_locked" };
    }
    if (current.status === "pending_review") {
      return {
        status: "pending_review" as const,
        authorization: current,
        cleanupPending: false,
      };
    }
    if (current.status === "rejected") {
      return { status: "rejected" as const, reasonCode: "authorization_terminal" };
    }
    if (current.status === "approved") {
      const preset = await provisionWhileApproved(current, dependencies);
      return { status: "approved" as const, authorization: current, preset };
    }
  }

  const decision = evaluateVoiceAuthorization(input);
  if (decision.status === "rejected") {
    return {
      status: "rejected" as const,
      reasonCode: decision.reasonCode,
    };
  }

  const attestedAt = new Date().toISOString();
  const automaticallyReviewed = decision.status === "approved";
  let authorization: VoiceAuthorization;
  try {
    authorization = await dependencies.repository.replaceVoiceAuthorization({
      id: randomUUID(),
      voiceId: input.voiceId,
      userId: input.userId,
      speakerStatus: input.speakerStatus,
      basis: input.basis,
      status: decision.status,
      reasonCode: decision.reasonCode,
      noticeVersion: VOICE_AUTHORIZATION_NOTICE_VERSION,
      separateConsentConfirmed: input.separateConsentConfirmed,
      thirdPartyProcessingConfirmed: input.thirdPartyProcessingConfirmed,
      syntheticDisclosureConfirmed: input.syntheticDisclosureConfirmed,
      attestedAt,
      reviewedAt: automaticallyReviewed ? attestedAt : null,
      reviewedBy: automaticallyReviewed ? "policy:self" : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "authorization_classification_locked") {
      return { status: "rejected" as const, reasonCode: "authorization_classification_locked" };
    }
    if (error instanceof Error && error.message === "authorization_state_changed") {
      return submitVoiceAuthorization(input, dependencies);
    }
    if (error instanceof Error && error.message === "voice_deletion_pending") {
      return { status: "rejected" as const, reasonCode: "voice_deletion_pending" };
    }
    throw error;
  }

  if (authorization.status !== "approved") {
    let cleanupPending = false;
    if (voice.providerVoiceId) {
      try {
        const revokePreset = dependencies.revokePreset || revokeVoicePreset;
        await revokePreset(input.voiceId, input.userId, dependencies);
      } catch {
        cleanupPending = true;
      }
    }
    return {
      status: "pending_review" as const,
      authorization,
      cleanupPending,
    };
  }

  const preset = await provisionWhileApproved(authorization, dependencies);
  return { status: "approved" as const, authorization, preset };
}

export type ReviewStoredVoiceAuthorizationInput = {
  authorizationId: string;
  decision: "approve" | "reject";
  reason: string;
  reviewerCredentialHash: string;
  expectedEnvironment: "local" | "preview" | "production";
  expectedTargetFingerprint: string;
  auditEventId: string;
  requestId: string;
};

export async function reviewStoredVoiceAuthorization(
  input: ReviewStoredVoiceAuthorizationInput,
  dependencies: ReviewDependencies,
) {
  const result = await dependencies.repository.reviewVoiceAuthorization({
    ...input,
    reviewedAt: (dependencies.nowIso || (() => new Date().toISOString()))(),
  });
  if (result.status !== "reviewed") return result;

  const authorization = result.authorization;
  if (authorization.status === "approved") {
    const preset = await provisionWhileApproved(authorization, dependencies);
    return { status: "approved" as const, authorization, preset };
  }

  let cleanupPending = false;
  try {
    const revokePreset = dependencies.revokePreset || revokeVoicePreset;
    await revokePreset(authorization.voiceId, authorization.userId, dependencies);
  } catch {
    cleanupPending = true;
  }
  return { status: "rejected" as const, authorization, cleanupPending };
}

export async function revokeStoredVoiceAuthorization(
  voiceId: string,
  userId: string,
  dependencies: RevokeDependencies,
  options: { deleteConversationData: boolean },
): Promise<
  | { status: "not_found" }
  | { status: "confirmation_required" }
  | { status: "processing"; jobId: string; currentStep: string; errorCode: string | null }
  | { status: "completed"; jobId: string }
> {
  if (!options.deleteConversationData) return { status: "confirmation_required" };

  let job = await dependencies.repository.getActiveVoiceDeletionJob(voiceId, userId);
  if (!job) {
    const [voice, authorization] = await Promise.all([
      dependencies.store.getMeta(voiceId, userId),
      dependencies.repository.getCurrentVoiceAuthorization(voiceId, userId),
    ]);
    if (!voice || !authorization) return { status: "not_found" };
    job = await dependencies.repository.beginVoiceDeletion({
      id: randomUUID(),
      voiceId,
      userId,
      authorizationId: authorization.id,
      providerVoiceId: voice.providerVoiceId,
      deleteConversationData: true,
    });
    if (!job) return { status: "not_found" };
  }

  const leaseToken = randomUUID();
  const claimed = await dependencies.repository.claimVoiceDeletionJob(job.id, userId, leaseToken);
  if (!claimed) {
    return { status: "processing", jobId: job.id, currentStep: job.currentStep, errorCode: job.lastErrorCode };
  }
  job = claimed;
  let currentJob = claimed;

  const retry = async (error: unknown) => {
    const explicitCode = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    const errorCode = currentJob.currentStep === "provider"
      ? (explicitCode.startsWith("voice_provider_") ? explicitCode : stableProviderErrorCode(error))
      : `voice_deletion_${currentJob.currentStep}_failed`;
    await dependencies.repository.updateVoiceDeletionJob({
      id: currentJob.id, userId, leaseToken, currentStep: currentJob.currentStep,
      status: "retry_pending", lastErrorCode: errorCode,
    });
    return { status: "processing" as const, jobId: currentJob.id, currentStep: currentJob.currentStep, errorCode };
  };

  if (job.currentStep === "provider") {
    try {
      let reconcileByName = false;
      const staleUnknownOperations: number[] = [];
      const pendingOperations = await dependencies.repository.listPendingVoiceProviderOperations(
        voiceId,
        userId,
      );
      for (const operation of pendingOperations) {
        if (!operation.providerVoiceId) {
          const updatedAt = Date.parse(operation.updatedAt);
          if (Number.isFinite(updatedAt) && Date.now() - updatedAt >= 5 * 60_000) {
            staleUnknownOperations.push(operation.generation);
            reconcileByName = true;
            continue;
          }
          throw Object.assign(new Error("provider operation is still in flight"), {
            code: "voice_provider_operation_in_flight",
          });
        }
        try {
          await (dependencies.removePreset || deletePresetVoice)(operation.providerVoiceId);
        } catch (error) {
          await dependencies.repository.settleSupersededVoiceProviderOperation(
            voiceId, userId, operation.generation,
            {
              providerVoiceId: operation.providerVoiceId,
              cleanupPending: true,
              errorCode: stableProviderErrorCode(error),
            },
          );
          throw error;
        }
        await dependencies.repository.settleSupersededVoiceProviderOperation(
          voiceId, userId, operation.generation,
          { providerVoiceId: null, cleanupPending: false, errorCode: null },
        );
      }
      const providerVoiceIds = new Set<string>();
      if (job.providerVoiceId) providerVoiceIds.add(job.providerVoiceId);
      if (reconcileByName) {
        const presets = await (dependencies.listPresets || listPresetVoices)();
        const customName = createPresetVoiceName(voiceId);
        for (const preset of presets) {
          if (preset.customName === customName) providerVoiceIds.add(preset.uri);
        }
      }
      for (const providerVoiceId of providerVoiceIds) {
        await (dependencies.removePreset || deletePresetVoice)(providerVoiceId);
      }
      for (const generation of staleUnknownOperations) {
        await dependencies.repository.settleSupersededVoiceProviderOperation(
          voiceId, userId, generation,
          { providerVoiceId: null, cleanupPending: false, errorCode: null },
        );
      }
      const advanced = await dependencies.repository.updateVoiceDeletionJob({
        id: job.id, userId, leaseToken, currentStep: "personas",
        status: "processing", lastErrorCode: null,
      });
      if (!advanced) return retry(new Error("deletion lease lost"));
      job = advanced;
      currentJob = advanced;
    } catch (error) {
      return retry(error);
    }
  }

  if (job.currentStep === "personas") {
    try {
      await dependencies.repository.softDeletePersonasForVoice(voiceId, userId, job.id);
      const advanced = await dependencies.repository.updateVoiceDeletionJob({
        id: job.id, userId, leaseToken, currentStep: "source",
        status: "processing", lastErrorCode: null,
      });
      if (!advanced) return retry(new Error("deletion lease lost"));
      job = advanced;
      currentJob = advanced;
    } catch (error) {
      return retry(error);
    }
  }

  if (job.currentStep === "source") {
    try {
      const existing = await dependencies.store.getMeta(voiceId, userId);
      if (existing) {
        const deleted = await dependencies.store.delete(voiceId, userId);
        if (!deleted) throw new Error("private source was not deleted");
      }
      await dependencies.repository.purgeVoiceData(voiceId, userId);
      const completed = await dependencies.repository.updateVoiceDeletionJob({
        id: job.id, userId, leaseToken, currentStep: "completed",
        status: "completed", lastErrorCode: null,
      });
      if (!completed) return retry(new Error("deletion lease lost"));
      return { status: "completed", jobId: job.id };
    } catch (error) {
      return retry(error);
    }
  }

  return { status: "completed", jobId: job.id };
}
