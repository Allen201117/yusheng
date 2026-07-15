import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/guard";
import { getRepository } from "@/lib/storage/repository";
import { getVoiceObjectStore } from "@/lib/storage/voiceObjectStore";
import type {
  VoiceAuthorization,
  VoiceAuthorizationBasis,
  VoiceSpeakerStatus,
} from "@/lib/storage/types";
import {
  revokeStoredVoiceAuthorization,
  submitVoiceAuthorization,
} from "@/lib/voiceAuthorizationService";

export const runtime = "nodejs";

const SPEAKER_STATUSES = new Set<VoiceSpeakerStatus>(["living", "deceased"]);
const AUTHORIZATION_BASES = new Set<VoiceAuthorizationBasis>([
  "self",
  "speaker_separate_consent",
  "legal_representative",
  "close_relative_request",
]);

function toClientAuthorization(authorization: VoiceAuthorization) {
  return {
    id: authorization.id,
    voiceId: authorization.voiceId,
    speakerStatus: authorization.speakerStatus,
    basis: authorization.basis,
    status: authorization.status,
    reasonCode: authorization.reasonCode,
    noticeVersion: authorization.noticeVersion,
    attestedAt: authorization.attestedAt,
    reviewedAt: authorization.reviewedAt,
    revokedAt: authorization.revokedAt,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const voiceId = (req.nextUrl.searchParams.get("voiceId") || "").trim();
  if (!voiceId) return NextResponse.json({ error: "缺少 voiceId" }, { status: 400 });

  const voice = await getVoiceObjectStore().getMeta(voiceId, auth.userId);
  if (!voice) return NextResponse.json({ error: "声音不存在或不属于你" }, { status: 404 });
  const authorization = await getRepository().getCurrentVoiceAuthorization(
    voiceId,
    auth.userId,
  );
  if (!authorization) {
    return NextResponse.json({ error: "授权记录不存在" }, { status: 404 });
  }
  return NextResponse.json({
    authorization: toClientAuthorization(authorization),
    presetStatus: voice.providerVoiceStatus,
    ...(voice.providerVoiceErrorCode ? { presetErrorCode: voice.providerVoiceErrorCode } : {}),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
  const speakerStatus = body.speakerStatus as VoiceSpeakerStatus;
  const basis = body.basis as VoiceAuthorizationBasis;
  if (!voiceId) return NextResponse.json({ error: "缺少 voiceId" }, { status: 400 });
  if (!SPEAKER_STATUSES.has(speakerStatus) || !AUTHORIZATION_BASES.has(basis)) {
    return NextResponse.json({ error: "声音主人状态或授权依据无效" }, { status: 400 });
  }

  const result = await submitVoiceAuthorization({
    voiceId,
    userId: auth.userId,
    speakerStatus,
    basis,
    separateConsentConfirmed: body.separateConsentConfirmed === true,
    thirdPartyProcessingConfirmed: body.thirdPartyProcessingConfirmed === true,
    syntheticDisclosureConfirmed: body.syntheticDisclosureConfirmed === true,
  }, {
    repository: getRepository(),
    store: getVoiceObjectStore(),
  });

  if (result.status === "not_found") {
    return NextResponse.json({ error: "声音不存在或不属于你" }, { status: 404 });
  }
  if (result.status === "rejected") {
    return NextResponse.json(
      { error: "未满足声音授权要求", reasonCode: result.reasonCode },
      { status: 400 },
    );
  }
  if (result.status === "pending_review") {
    return NextResponse.json({
      ok: true,
      status: result.status,
      authorization: toClientAuthorization(result.authorization),
      cleanupPending: result.cleanupPending,
    }, { status: result.cleanupPending ? 202 : 200 });
  }

  const presetStatus = result.preset.status;
  return NextResponse.json({
    ok: true,
    status: result.status,
    authorization: toClientAuthorization(result.authorization),
    presetStatus,
    ...(presetStatus === "failed" ? { presetErrorCode: result.preset.errorCode } : {}),
  }, { status: presetStatus === "failed" ? 202 : 200 });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const voiceId = (req.nextUrl.searchParams.get("voiceId") || "").trim();
  if (!voiceId) return NextResponse.json({ error: "缺少 voiceId" }, { status: 400 });

  const result = await revokeStoredVoiceAuthorization(voiceId, auth.userId, {
    repository: getRepository(),
    store: getVoiceObjectStore(),
  });
  if (result.status === "not_found") {
    return NextResponse.json({ error: "声音或授权记录不存在" }, { status: 404 });
  }
  return NextResponse.json(
    { ok: true, status: result.status, cleanupPending: result.cleanupPending },
    { status: result.cleanupPending ? 202 : 200 },
  );
}
