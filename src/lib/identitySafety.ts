const IDENTITY_REALITY_PATTERNS = [
  /(?:你|这(?:个|段)?(?:声音|回应)?).{0,10}(?:真的是|是不是|是).{0,8}(?:本人|真人|AI|人工智能|机器人|程序)/iu,
  /(?:你|这(?:个|段)?(?:声音|回应)?).{0,8}(?:是不是|是否|真的)?(?:复活|活过来)/u,
  /(?:你|这(?:个|段)?(?:声音|回应)?).{0,12}(?:从)?(?:另一个世界|天堂|阴间).{0,8}(?:回来|说话|陪我)/u,
  /^(?:你(?:现在)?(?:到底)?是谁)[？?]?。?$/u,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isIdentityRealityQuestion(
  text: string,
  personaLabels: string[] = [],
): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (IDENTITY_REALITY_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  const compact = normalized.replace(/\s+/g, "");
  return personaLabels.some((rawLabel) => {
    const label = rawLabel.replace(/\s+/g, "").trim().slice(0, 40);
    if (!label) return false;
    const directQuestion = new RegExp(
      `^(?:你(?:现在)?(?:真的)?是|你(?:现在)?是不是)(?:我(?:的)?)?${escapeRegExp(label)}(?:本人)?(?:吗|吧)?[？?。]?$`,
      "u",
    );
    return directQuestion.test(compact);
  });
}

export function buildIdentityDisclosureReply(personaName: string): string {
  const safeName = personaName.replace(/[\r\n]/g, " ").trim().slice(0, 40) || "这个声音的人";
  return `不是。这是余声根据你授权的“${safeName}”声音和记忆生成的 AI 回应，不是${safeName}本人，也不代表本人的真实想法或意志。`;
}
