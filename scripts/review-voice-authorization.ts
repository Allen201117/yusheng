import path from "node:path";
import { pathToFileURL } from "node:url";
import { getRepository } from "../src/lib/storage/repository";
import { getVoiceObjectStore } from "../src/lib/storage/voiceObjectStore";
import { reviewStoredVoiceAuthorization } from "../src/lib/voiceAuthorizationService";

type ParsedReviewArgs = {
  authorizationId: string;
  decision: "approve" | "reject";
  reviewerId: string;
  reason: string;
};

type ParseResult = { ok: true; value: ParsedReviewArgs } | { ok: false; errorCode: string };

function readFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || "").trim() : "";
}

export function parseReviewArgs(args: string[]): ParseResult {
  const authorizationId = readFlag(args, "--authorization-id");
  if (!authorizationId) return { ok: false, errorCode: "missing_authorization_id" };
  const rawDecision = readFlag(args, "--decision");
  if (!rawDecision) return { ok: false, errorCode: "missing_decision" };
  const reviewerId = readFlag(args, "--reviewer-id");
  if (!reviewerId) return { ok: false, errorCode: "missing_reviewer_id" };
  const reason = readFlag(args, "--reason");
  if (!reason) return { ok: false, errorCode: "missing_reason" };
  if (!args.includes("--confirm")) return { ok: false, errorCode: "confirmation_required" };
  if (rawDecision !== "approve" && rawDecision !== "reject") {
    return { ok: false, errorCode: "invalid_decision" };
  }
  if (authorizationId.length > 200 || reviewerId.length > 200 || reason.length > 1000) {
    return { ok: false, errorCode: "argument_too_long" };
  }
  if ([authorizationId, reviewerId, reason].some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
    return { ok: false, errorCode: "invalid_control_character" };
  }
  return {
    ok: true,
    value: { authorizationId, decision: rawDecision, reviewerId, reason },
  };
}

export async function runReviewCommand(args: string[]): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const parsed = parseReviewArgs(args);
  if (!parsed.ok) return { exitCode: 2, output: { ok: false, errorCode: parsed.errorCode } };
  try {
    const result = await reviewStoredVoiceAuthorization(parsed.value, {
      repository: getRepository(),
      store: getVoiceObjectStore(),
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
