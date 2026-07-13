export type SpeechEmotion = "calm" | "warm" | "happy" | "sad" | "concerned" | "nostalgic";

export type SpeechPlan = {
  index: number;
  text: string;
  emotion: SpeechEmotion;
  intensity: number;
  speed: number;
  pauseAfterMs: number;
};

export type SpeechControls = {
  emotion: SpeechEmotion;
  intensity: number;
  speed: number;
};

const HARD_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const SOFT_BOUNDARIES = new Set(["，", ","]);

export function extractSpeakableSentences(
  input: string,
  maxUnpunctuatedChars = 36,
): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < input.length; index += 1) {
    if (!HARD_BOUNDARIES.has(input[index])) continue;
    const sentence = input.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }

  let remainder = input.slice(start).trimStart();
  if (remainder.length > maxUnpunctuatedChars) {
    const boundary = [...remainder]
      .slice(0, maxUnpunctuatedChars + 1)
      .findIndex((character) => SOFT_BOUNDARIES.has(character));
    if (boundary >= 0) {
      const clause = remainder.slice(0, boundary + 1).trim();
      if (clause) sentences.push(clause);
      remainder = remainder.slice(boundary + 1).trimStart();
    }
  }

  return { sentences, remainder };
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function createSpeechPlan(text: string, index: number): SpeechPlan {
  const normalized = text.trim();
  if (includesAny(normalized, ["太好了", "开心", "高兴", "真好", "哈哈", "替你开心"])) {
    return { index, text: normalized, emotion: "happy", intensity: 72, speed: 1.05, pauseAfterMs: 280 };
  }
  if (includesAny(normalized, ["想你", "想念", "还记得", "以前", "那时候", "小时候"])) {
    return { index, text: normalized, emotion: "nostalgic", intensity: 62, speed: 0.94, pauseAfterMs: 420 };
  }
  if (includesAny(normalized, ["辛苦", "担心", "害怕", "扛了", "还好吗", "照顾好自己"])) {
    return { index, text: normalized, emotion: "concerned", intensity: 68, speed: 0.92, pauseAfterMs: 420 };
  }
  if (includesAny(normalized, ["难过", "伤心", "哭", "遗憾", "舍不得", "心疼"])) {
    return { index, text: normalized, emotion: "sad", intensity: 58, speed: 0.9, pauseAfterMs: 500 };
  }
  if (includesAny(normalized, ["谢谢", "抱抱", "喜欢", "陪着你", "慢慢说"])) {
    return { index, text: normalized, emotion: "warm", intensity: 55, speed: 0.96, pauseAfterMs: 360 };
  }
  return { index, text: normalized, emotion: "calm", intensity: 45, speed: 1, pauseAfterMs: 320 };
}

export class SpeechPlanAccumulator {
  remainder = "";
  private nextIndex = 0;

  push(token: string): SpeechPlan[] {
    const extracted = extractSpeakableSentences(this.remainder + token);
    this.remainder = extracted.remainder;
    return extracted.sentences.map((sentence) => createSpeechPlan(sentence, this.nextIndex++));
  }

  flush(): SpeechPlan[] {
    const text = this.remainder.trim();
    this.remainder = "";
    return text ? [createSpeechPlan(text, this.nextIndex++)] : [];
  }
}

const PROVIDER_PROMPTS: Record<SpeechEmotion, string> = {
  calm: "请用自然、平静、像日常聊天一样的语气说",
  warm: "请用温暖、亲近但不过度煽情的语气说",
  happy: "请用自然开心、带一点笑意的语气说",
  sad: "请用低缓、克制、略带难过但不夸张的语气说",
  concerned: "请用关切、温和而克制的语气说",
  nostalgic: "请用温柔怀念、像在回忆往事的语气说",
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeSpeechControls(value: unknown): SpeechControls | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.emotion !== "string"
    || !Object.prototype.hasOwnProperty.call(PROVIDER_PROMPTS, candidate.emotion)) {
    return null;
  }
  const intensity = typeof candidate.intensity === "number" ? candidate.intensity : 45;
  const speed = typeof candidate.speed === "number" ? candidate.speed : 1;
  return {
    emotion: candidate.emotion as SpeechEmotion,
    intensity: clamp(intensity, 0, 100),
    speed: clamp(speed, 0.75, 1.15),
  };
}

export function toCosyVoiceControls(input: SpeechControls): {
  prompt: string;
  speed: number;
  gain: number;
} {
  const supported = Object.prototype.hasOwnProperty.call(PROVIDER_PROMPTS, input.emotion);
  const emotion: SpeechEmotion = supported ? input.emotion : "calm";
  const intensity = clamp(input.intensity, 0, 100);
  const speed = clamp(input.speed, 0.75, 1.15);
  const base = PROVIDER_PROMPTS[emotion];

  if (!supported || emotion === "calm") return { prompt: `${base}。`, speed, gain: 0 };
  const strength = intensity >= 67 ? "较强" : intensity >= 34 ? "适中" : "轻微";
  return { prompt: `${base}，情绪强度${strength}。`, speed, gain: 0 };
}
