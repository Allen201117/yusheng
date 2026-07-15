import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildVoiceAuthorizationPayload,
  createVoiceAuthorizationRequestGate,
  mapVoiceAuthorizationStatus,
  runLatestVoiceAuthorizationRequest,
} from "../src/lib/voiceAuthorizationClient";

it("builds a production authorization payload for one selected voice", () => {
  assert.deepEqual(buildVoiceAuthorizationPayload({
    voiceId: " voice-1 ", speakerStatus: "living", basis: "self",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true,
  }), {
    voiceId: "voice-1", speakerStatus: "living", basis: "self",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true,
  });
});

it("maps stable authorization states without claiming pending voices are usable", () => {
  assert.deepEqual(mapVoiceAuthorizationStatus(null), {
    kind: "not_submitted", label: "尚未提交授权", canContinue: false, errorCode: null,
  });
  assert.equal(mapVoiceAuthorizationStatus({ status: "pending_review", reasonCode: "manual_review_required" }).canContinue, false);
  assert.equal(mapVoiceAuthorizationStatus({ status: "approved", reasonCode: null }).canContinue, true);
  assert.equal(mapVoiceAuthorizationStatus({ status: "rejected", reasonCode: "invalid_evidence" }).label, "审核未通过");
  assert.equal(mapVoiceAuthorizationStatus({ status: "revoked", reasonCode: null }).label, "授权已撤回");
});

it("wires the production voice page to per-voice status, submit and revoke calls", async () => {
  const source = await readFile(new URL("../src/app/voice/new/page.tsx", import.meta.url), "utf8");
  assert.match(source, /buildVoiceAuthorizationPayload/);
  assert.match(source, /mapVoiceAuthorizationStatus/);
  assert.match(source, /api\/voice\/authorization\?voiceId=/);
  assert.match(source, /method:\s*["']POST["']/);
  assert.match(source, /method:\s*["']DELETE["']/);
  assert.match(source, /authorizationVoiceId === selectedVoiceId/);
  assert.match(source, /runLatestVoiceAuthorizationRequest/);
});

it("finishes loading after a successful revoke request", async () => {
  const loading: boolean[] = [];
  const applied: string[] = [];
  await runLatestVoiceAuthorizationRequest({
    gate: createVoiceAuthorizationRequestGate(),
    setLoading: (value) => loading.push(value),
    request: async () => "revoked",
    onSuccess: (value) => applied.push(value),
    onError: () => assert.fail("must not fail"),
  });
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(applied, ["revoked"]);
});

it("does not let an older voice request apply or clear a newer request", async () => {
  let resolveOld!: (value: string) => void;
  let resolveNew!: (value: string) => void;
  const oldPromise = new Promise<string>((resolve) => { resolveOld = resolve; });
  const newPromise = new Promise<string>((resolve) => { resolveNew = resolve; });
  const gate = createVoiceAuthorizationRequestGate();
  const loading: boolean[] = [];
  const applied: string[] = [];
  const oldRun = runLatestVoiceAuthorizationRequest({
    gate, setLoading: (value) => loading.push(value), request: () => oldPromise,
    onSuccess: (value) => applied.push(value), onError: () => assert.fail("old must not fail"),
  });
  const newRun = runLatestVoiceAuthorizationRequest({
    gate, setLoading: (value) => loading.push(value), request: () => newPromise,
    onSuccess: (value) => applied.push(value), onError: () => assert.fail("new must not fail"),
  });
  resolveNew("voice-new");
  await newRun;
  resolveOld("voice-old");
  await oldRun;
  assert.deepEqual(applied, ["voice-new"]);
  assert.deepEqual(loading, [true, true, false]);
});
