import type {
  VoiceAuthorizationBasis,
  VoiceAuthorizationStatus,
  VoiceSpeakerStatus,
} from "./storage/types";

export type VoiceAuthorizationPayload = {
  voiceId: string;
  speakerStatus: VoiceSpeakerStatus;
  basis: VoiceAuthorizationBasis;
  separateConsentConfirmed: boolean;
  thirdPartyProcessingConfirmed: boolean;
  syntheticDisclosureConfirmed: boolean;
};

export function buildVoiceAuthorizationPayload(
  input: VoiceAuthorizationPayload,
): VoiceAuthorizationPayload {
  return { ...input, voiceId: input.voiceId.trim() };
}

export type VoiceAuthorizationDisplay = {
  kind: VoiceAuthorizationStatus | "not_submitted";
  label: string;
  canContinue: boolean;
  errorCode: string | null;
};

export function mapVoiceAuthorizationStatus(
  authorization: { status: VoiceAuthorizationStatus; reasonCode: string | null } | null,
): VoiceAuthorizationDisplay {
  if (!authorization) {
    return { kind: "not_submitted", label: "尚未提交授权", canContinue: false, errorCode: null };
  }
  const labels: Record<VoiceAuthorizationStatus, string> = {
    pending_review: "等待人工审核",
    approved: "授权已通过",
    rejected: "审核未通过",
    revoked: "授权已撤回",
  };
  return {
    kind: authorization.status,
    label: labels[authorization.status],
    canContinue: authorization.status === "approved",
    errorCode: authorization.reasonCode,
  };
}
