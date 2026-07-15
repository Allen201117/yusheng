import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { getRepository } from "../src/lib/storage/repository";
import { getVoiceObjectStore } from "../src/lib/storage/voiceObjectStore";
import { reviewStoredVoiceAuthorization } from "../src/lib/voiceAuthorizationService";
import type { AppRepository } from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

type ParsedReviewArgs = {
  authorizationId: string;
  decision: "approve" | "reject";
  reason: string;
  expectedEnvironment: "local" | "preview" | "production";
  expectedTargetFingerprint: string;
};

type ParseResult = { ok: true; value: ParsedReviewArgs } | { ok: false; errorCode: string };

export function parseReviewArgs(args: string[]): ParseResult {
  const values = new Map<string, string>();
  const valueFlags = new Set([
    "--authorization-id",
    "--decision",
    "--reason",
    "--expected-environment",
    "--expected-target",
    "--confirm",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) return { ok: false, errorCode: "unexpected_argument" };
    if (!valueFlags.has(flag)) return { ok: false, errorCode: "unknown_argument" };
    if (values.has(flag)) return { ok: false, errorCode: "duplicate_argument" };
    const rawValue = args[index + 1];
    if (rawValue === undefined || rawValue.startsWith("--") || !rawValue.trim()) {
      return { ok: false, errorCode: "missing_argument_value" };
    }
    values.set(flag, rawValue.trim());
    index += 1;
  }

  const authorizationId = values.get("--authorization-id") || "";
  if (!authorizationId) return { ok: false, errorCode: "missing_authorization_id" };
  const rawDecision = values.get("--decision") || "";
  if (!rawDecision) return { ok: false, errorCode: "missing_decision" };
  const reason = values.get("--reason") || "";
  if (!reason) return { ok: false, errorCode: "missing_reason" };
  const rawEnvironment = values.get("--expected-environment") || "";
  if (!rawEnvironment) return { ok: false, errorCode: "missing_expected_environment" };
  if (!["local", "preview", "production"].includes(rawEnvironment)) {
    return { ok: false, errorCode: "invalid_expected_environment" };
  }
  const expectedTargetFingerprint = values.get("--expected-target") || "";
  if (!expectedTargetFingerprint) return { ok: false, errorCode: "missing_expected_target" };
  if (!/^[0-9a-f]{32}$/.test(expectedTargetFingerprint)) {
    return { ok: false, errorCode: "invalid_expected_target" };
  }
  const confirmation = values.get("--confirm") || "";
  if (!confirmation) return { ok: false, errorCode: "confirmation_required" };
  if (rawDecision !== "approve" && rawDecision !== "reject") {
    return { ok: false, errorCode: "invalid_decision" };
  }
  const expectedConfirmation = `review:${rawEnvironment}:${expectedTargetFingerprint}:${authorizationId}:${rawDecision}`;
  if (confirmation !== expectedConfirmation) {
    return { ok: false, errorCode: "confirmation_mismatch" };
  }
  if (authorizationId.length > 200 || reason.length > 1000) {
    return { ok: false, errorCode: "argument_too_long" };
  }
  if ([authorizationId, reason].some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
    return { ok: false, errorCode: "invalid_control_character" };
  }
  return {
    ok: true,
    value: {
      authorizationId,
      decision: rawDecision,
      reason,
      expectedEnvironment: rawEnvironment as ParsedReviewArgs["expectedEnvironment"],
      expectedTargetFingerprint,
    },
  };
}

type ReviewCommandDependencies = {
  env?: Record<string, string | undefined>;
  getRepository?: () => AppRepository;
  getStore?: () => VoiceObjectStore;
  randomId?: () => string;
};

export async function runReviewCommand(
  args: string[],
  dependencies: ReviewCommandDependencies = {},
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const parsed = parseReviewArgs(args);
  if (!parsed.ok) return { exitCode: 2, output: { ok: false, errorCode: parsed.errorCode } };
  const token = (dependencies.env || process.env).VOICE_AUTH_REVIEWER_TOKEN || "";
  if (!token) {
    return { exitCode: 2, output: { ok: false, errorCode: "reviewer_token_required" } };
  }
  if (token.length < 32 || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) {
    return { exitCode: 2, output: { ok: false, errorCode: "reviewer_token_invalid" } };
  }
  const reviewerCredentialHash = createHash("sha256").update(token).digest("hex");
  const randomId = dependencies.randomId || randomUUID;
  try {
    const result = await reviewStoredVoiceAuthorization({
      ...parsed.value,
      reviewerCredentialHash,
      auditEventId: randomId(),
      requestId: randomId(),
    }, {
      repository: (dependencies.getRepository || getRepository)(),
      store: (dependencies.getStore || getVoiceObjectStore)(),
    });
    if (result.status !== "approved" && result.status !== "rejected") {
      return { exitCode: 2, output: { ok: false, errorCode: `authorization_${result.status}` } };
    }
    if (result.status === "approved") {
      return {
        exitCode: result.preset.status === "ready" ? 0 : 3,
        output: {
          ok: true,
          status: "approved",
          authorizationId: result.authorization.id,
          presetStatus: result.preset.status,
          ...(result.preset.status === "failed" ? { presetErrorCode: result.preset.errorCode } : {}),
        },
      };
    }
    return {
      exitCode: result.cleanupPending ? 3 : 0,
      output: {
        ok: true,
        status: "rejected",
        authorizationId: result.authorization.id,
        cleanupPending: result.cleanupPending,
      },
    };
  } catch {
    return { exitCode: 3, output: { ok: false, errorCode: "review_unavailable" } };
  }
}

async function main() {
  const result = await runReviewCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) void main();
