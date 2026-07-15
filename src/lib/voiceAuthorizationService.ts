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

type Dependencies = {
  repository: AppRepository;
  store: VoiceObjectStore;
};

type SubmitDependencies = Dependencies & {
  provision?: typeof provisionVoicePreset;
  revokePreset?: typeof revokeVoicePreset;
};

type RevokeDependencies = Dependencies & {
  revokePreset?: typeof revokeVoicePreset;
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
  reviewerId: string;
  reason: string;
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
): Promise<
  | { status: "not_found" }
  | { status: "revoked"; cleanupPending: boolean; authorization?: VoiceAuthorization }
  | { status: "rejected"; cleanupPending: boolean; authorization: VoiceAuthorization }
> {
  const voice = await dependencies.store.getMeta(voiceId, userId);
  if (!voice) return { status: "not_found" };

  const authorization = await dependencies.repository.revokeVoiceAuthorization(voiceId, userId);
  if (!authorization) return { status: "not_found" };
  const status = authorization.status === "rejected" ? "rejected" as const : "revoked" as const;

  try {
    const revokePreset = dependencies.revokePreset || revokeVoicePreset;
    await revokePreset(voiceId, userId, dependencies);
    return { status, cleanupPending: false, authorization };
  } catch {
    return status === "rejected"
      ? { status, cleanupPending: true, authorization }
      : { status, cleanupPending: true };
  }
}
