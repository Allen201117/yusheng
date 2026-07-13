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

export type SubmitVoiceAuthorizationInput = VoiceAuthorizationAttestation & {
  voiceId: string;
  userId: string;
};

export async function submitVoiceAuthorization(
  input: SubmitVoiceAuthorizationInput,
  dependencies: SubmitDependencies,
) {
  const voice = await dependencies.store.getMeta(input.voiceId, input.userId);
  if (!voice) return { status: "not_found" as const };

  const decision = evaluateVoiceAuthorization(input);
  if (decision.status === "rejected") {
    return {
      status: "rejected" as const,
      reasonCode: decision.reasonCode,
    };
  }

  const attestedAt = new Date().toISOString();
  const authorization = await dependencies.repository.replaceVoiceAuthorization({
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
  });

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

  const provision = dependencies.provision || provisionVoicePreset;
  const preset = await provision(input.voiceId, input.userId, dependencies);
  return { status: "approved" as const, authorization, preset };
}

export async function revokeStoredVoiceAuthorization(
  voiceId: string,
  userId: string,
  dependencies: RevokeDependencies,
): Promise<
  | { status: "not_found" }
  | { status: "revoked"; cleanupPending: boolean; authorization?: VoiceAuthorization }
> {
  const voice = await dependencies.store.getMeta(voiceId, userId);
  if (!voice) return { status: "not_found" };

  const authorization = await dependencies.repository.revokeVoiceAuthorization(voiceId, userId);
  if (!authorization) return { status: "not_found" };

  try {
    const revokePreset = dependencies.revokePreset || revokeVoicePreset;
    await revokePreset(voiceId, userId, dependencies);
    return { status: "revoked", cleanupPending: false, authorization };
  } catch {
    return { status: "revoked", cleanupPending: true };
  }
}
