import { it } from "node:test";
import assert from "node:assert/strict";
import {
  canSynthesizeVoice,
  evaluateVoiceAuthorization,
  VOICE_AUTHORIZATION_NOTICE_VERSION,
} from "../src/lib/voiceAuthorizationPolicy";

const confirmations = {
  separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true,
  syntheticDisclosureConfirmed: true,
};

it("approves only a living speaker authorizing their own voice", () => {
  assert.deepEqual(evaluateVoiceAuthorization({
    speakerStatus: "living",
    basis: "self",
    ...confirmations,
  }), { status: "approved", reasonCode: null });
  assert.equal(VOICE_AUTHORIZATION_NOTICE_VERSION, "voice-authorization-2026-07-13");
});

it("keeps living third-party consent pending evidence review", () => {
  assert.deepEqual(evaluateVoiceAuthorization({
    speakerStatus: "living",
    basis: "speaker_separate_consent",
    ...confirmations,
  }), {
    status: "pending_review",
    reasonCode: "manual_review_required",
  });
});

it("does not treat close-relative status as automatic deceased-voice approval", () => {
  assert.deepEqual(evaluateVoiceAuthorization({
    speakerStatus: "deceased",
    basis: "close_relative_request",
    ...confirmations,
  }), {
    status: "pending_review",
    reasonCode: "manual_review_required",
  });
});

it("rejects missing separate confirmations and impossible basis combinations", () => {
  assert.deepEqual(evaluateVoiceAuthorization({
    speakerStatus: "living",
    basis: "self",
    ...confirmations,
    thirdPartyProcessingConfirmed: false,
  }), {
    status: "rejected",
    reasonCode: "required_confirmation_missing",
  });
  assert.deepEqual(evaluateVoiceAuthorization({
    speakerStatus: "deceased",
    basis: "self",
    ...confirmations,
  }), {
    status: "rejected",
    reasonCode: "invalid_basis_for_speaker_status",
  });
});

it("always blocks revoked authorization and supports staged enforcement", () => {
  const approved = { status: "approved" as const };
  const revoked = { status: "revoked" as const };
  const pending = { status: "pending_review" as const };

  assert.equal(canSynthesizeVoice({ authorization: revoked, enforcementEnabled: false }), false);
  assert.equal(canSynthesizeVoice({ authorization: null, enforcementEnabled: false }), true);
  assert.equal(canSynthesizeVoice({ authorization: pending, enforcementEnabled: false }), false);
  assert.equal(canSynthesizeVoice({ authorization: approved, enforcementEnabled: false }), true);
  assert.equal(canSynthesizeVoice({ authorization: null, enforcementEnabled: true }), false);
  assert.equal(canSynthesizeVoice({ authorization: pending, enforcementEnabled: true }), false);
  assert.equal(canSynthesizeVoice({ authorization: approved, enforcementEnabled: true }), true);
});
