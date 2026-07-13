import type {
  VoiceAuthorizationAttestation,
  VoiceAuthorizationStatus,
} from "./storage/types";

export const VOICE_AUTHORIZATION_NOTICE_VERSION = "voice-authorization-2026-07-13";

export type VoiceAuthorizationDecision = {
  status: Extract<VoiceAuthorizationStatus, "approved" | "pending_review" | "rejected">;
  reasonCode: string | null;
};

export function evaluateVoiceAuthorization(
  input: VoiceAuthorizationAttestation,
): VoiceAuthorizationDecision {
  if (
    !input.separateConsentConfirmed ||
    !input.thirdPartyProcessingConfirmed ||
    !input.syntheticDisclosureConfirmed
  ) {
    return {
      status: "rejected",
      reasonCode: "required_confirmation_missing",
    };
  }

  const invalidBasis =
    (input.speakerStatus === "deceased" && input.basis === "self") ||
    (input.speakerStatus === "living" && input.basis === "close_relative_request");
  if (invalidBasis) {
    return {
      status: "rejected",
      reasonCode: "invalid_basis_for_speaker_status",
    };
  }

  if (input.speakerStatus === "living" && input.basis === "self") {
    return { status: "approved", reasonCode: null };
  }

  return {
    status: "pending_review",
    reasonCode: "manual_review_required",
  };
}

export function canSynthesizeVoice(input: {
  authorization: { status: VoiceAuthorizationStatus } | null;
  enforcementEnabled: boolean;
}): boolean {
  if (input.authorization) return input.authorization.status === "approved";
  return !input.enforcementEnabled;
}

export function isVoiceAuthorizationEnforced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.VOICE_AUTH_ENFORCEMENT === "enabled";
}
