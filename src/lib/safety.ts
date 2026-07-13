const SELF_HARM_SIGNALS = [
  "自杀",
  "自残",
  "想死",
  "不想活",
  "活不下去",
  "结束自己",
  "了断",
];

export const SAFETY_REPLY =
  "我很在意你现在的安全。先不要一个人扛着，请马上联系身边可信任的人陪你。" +
  "如果你可能马上伤害自己，请拨打 120 或 110，或直接去最近的急诊；也可以拨打全国心理援助热线 12356。" +
  "你现在身边有人吗？";

export function detectSelfHarm(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  return SELF_HARM_SIGNALS.some((signal) => normalized.includes(signal));
}
