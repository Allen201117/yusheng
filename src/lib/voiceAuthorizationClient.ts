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

export type VoiceAuthorizationRequestGate = {
  begin(): number;
  cancel(): void;
  isCurrent(token: number): boolean;
  finish(token: number): boolean;
};

export function createVoiceAuthorizationRequestGate(): VoiceAuthorizationRequestGate {
  let currentToken = 0;
  return {
    begin() {
      currentToken += 1;
      return currentToken;
    },
    cancel() {
      currentToken += 1;
    },
    isCurrent(token) {
      return token === currentToken;
    },
    finish(token) {
      return token === currentToken;
    },
  };
}

export async function runLatestVoiceAuthorizationRequest<T>(input: {
  gate: VoiceAuthorizationRequestGate;
  setLoading: (loading: boolean) => void;
  request: () => Promise<T>;
  onSuccess: (value: T) => unknown;
  onError: (error: unknown) => unknown;
}): Promise<void> {
  const token = input.gate.begin();
  input.setLoading(true);
  try {
    const value = await input.request();
    if (input.gate.isCurrent(token)) await input.onSuccess(value);
  } catch (error) {
    if (input.gate.isCurrent(token)) await input.onError(error);
  } finally {
    if (input.gate.finish(token)) input.setLoading(false);
  }
}

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
