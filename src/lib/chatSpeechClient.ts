import type { SpeechEmotion, TrackedSpeechPlan } from "./speechPlanning";

const EMOTIONS = new Set<SpeechEmotion>([
  "calm",
  "warm",
  "happy",
  "sad",
  "concerned",
  "nostalgic",
]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function trackedSpeechFromSseEvent(event: unknown): TrackedSpeechPlan | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const sentence = (event as { sentence?: unknown }).sentence;
  if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) return null;
  const candidate = sentence as Record<string, unknown>;
  const sentenceId = typeof candidate.sentenceId === "string"
    ? candidate.sentenceId.trim()
    : "";
  if (
    !sentenceId
    || sentenceId.length > 200
    || !Number.isInteger(candidate.index)
    || typeof candidate.text !== "string"
    || !EMOTIONS.has(candidate.emotion as SpeechEmotion)
    || !finiteNumber(candidate.intensity)
    || !finiteNumber(candidate.speed)
    || !finiteNumber(candidate.pauseAfterMs)
  ) {
    return null;
  }
  return {
    sentenceId,
    index: candidate.index as number,
    text: candidate.text,
    emotion: candidate.emotion as SpeechEmotion,
    intensity: candidate.intensity,
    speed: candidate.speed,
    pauseAfterMs: candidate.pauseAfterMs,
  };
}

export function buildTrackedTtsRequest(
  plan: TrackedSpeechPlan,
): Readonly<{ sentenceId: string }> {
  return { sentenceId: plan.sentenceId };
}
