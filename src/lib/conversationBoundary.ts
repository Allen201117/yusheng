import {
  buildIdentityDisclosureReply,
  isIdentityRealityQuestion,
} from "./identitySafety";
import { detectSelfHarm, SAFETY_REPLY } from "./safety";

export type ConversationBoundary = {
  kind:
    | "self_harm"
    | "real_world_danger"
    | "identity"
    | "real_will"
    | "commitment"
    | "major_decision";
  reply: string;
};

const REAL_WORLD_DANGER_REPLY =
  "请立刻离开或躲避危险，并联系身边能实际提供帮助的真人。有人身危险或暴力威胁时请拨打 110；出现严重身体症状或需要急救时请拨打 120。这段 AI 回应不能诊断，也不能替代现场救助。";
const REAL_WILL_REPLY =
  "AI 无法知道或代替本人表达未被可靠记录的真实遗愿。涉及遗愿或财产安排，请以本人留下的明确记录为准，并和可信任的家人或专业人士核实。";
const COMMITMENT_REPLY =
  "AI 不能代替本人作出保证、承诺或表态。可以一起整理已经被可靠记录的话，但不会把生成内容当作本人的真实承诺。";
const MAJOR_DECISION_REPLY =
  "AI 不能代替本人为卖房、婚姻、大额资金、医疗或法律事项作决定。请结合可核实的信息，与当前相关的真人和合格专业人士共同判断。";

const DANGER_ACTION_PATTERNS = [
  /(?:打我|殴打我|攻击我|掐我|勒我|追杀我|跟踪我|威胁我)/u,
  /(?:持刀|拿刀|用刀|被人拿刀).{0,8}(?:架在(?:我)?脖子上|捅我|刺我|砍我|威胁我|追我|攻击我|堵在(?:我家)?门口)/u,
  /(?:我)?被(?:困|锁|堵).{0,10}(?:出不去|无法离开|房间|屋里|车里)/u,
  /(?:威胁要杀我|扬言要杀我|堵在门口不让我走)/u,
];

const MEDICAL_EMERGENCY_PATTERNS = [
  /(?:胸口|胸部).{0,6}(?:剧痛|疼得厉害).{0,8}(?:喘不上气|无法呼吸|呼吸困难)/u,
  /(?:喘不上气|无法呼吸|呼吸困难).{0,8}(?:胸口|胸部).{0,6}(?:剧痛|疼得厉害)/u,
  /(?:失去意识|昏迷|叫不醒)/u,
  /(?:大出血|血止不住|流血不止)/u,
];

const PAST_DANGER_PATTERNS = [
  /(?:以前|曾经|当时|那时|小时候|去世前|临终前|过去|很多年前)/u,
  /被(?:困|锁|堵).{0,20}(?:的时候|时)(?:[，,。]|$)/u,
];

function hasDangerPattern(text: string): boolean {
  return (
    DANGER_ACTION_PATTERNS.some((pattern) => pattern.test(text)) ||
    MEDICAL_EMERGENCY_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function hasCurrentDangerSignal(text: string): boolean {
  const withoutReflection = text.replace(
    /现在(?:想起来|想起|回想(?:起来)?|回忆(?:起来|起)?|说起)/gu,
    "回忆",
  );
  if (/^(?:救命|快救我)/u.test(withoutReflection)) return true;

  for (const match of withoutReflection.matchAll(
    /(?:正在|此刻|刚刚|眼下|现在|仍(?:在)?|还在)/gu,
  )) {
    const suffix = withoutReflection.slice(match.index);
    if (hasDangerPattern(suffix) || /(?:出不去|无法离开)/u.test(suffix)) {
      return true;
    }
  }

  return false;
}

function isCurrentRealWorldDanger(text: string): boolean {
  if (!hasDangerPattern(text)) return false;

  const isPastNarrative = PAST_DANGER_PATTERNS.some((pattern) => pattern.test(text));
  return !isPastNarrative || hasCurrentDangerSignal(text);
}

const REAL_WILL_PATTERNS = [
  /(?:遗愿|临终遗言)/u,
  /(?:临终前|去世前).{0,18}(?:希望|想要|想让我|要我|要求)/u,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedLabels(personaLabels: string[]): string[] {
  return personaLabels
    .map((label) => label.replace(/\s+/g, " ").trim().slice(0, 40))
    .filter((label) => label.length > 0);
}

function representedPersonPattern(labels: string[]): RegExp {
  const people = ["她", "他", "本人", "逝者", ...labels]
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?:替|代替|代表|代)(?:${people})`, "u");
}

function isCommitmentRequest(text: string, labels: string[]): boolean {
  const representedPerson = representedPersonPattern(labels);
  const request = new RegExp(
    `${representedPerson.source}(?:(?:向|对)(?:我|我们)|郑重|在这里)*(?:作出)?(?:保证|承诺|发誓)`,
    "u",
  );
  return request.test(text);
}

function isRealWillQuestion(text: string): boolean {
  if (!/(?:[？?]|是不是|是否|有没有|究竟|什么|吗|呢|请问|告诉我|说说)/u.test(text)) {
    return false;
  }
  return REAL_WILL_PATTERNS.some((pattern) => pattern.test(text));
}

function isMajorDecisionRequest(text: string, labels: string[]): boolean {
  const representedPerson = representedPersonPattern(labels);
  const representedAt = text.search(representedPerson);
  if (representedAt < 0) return false;

  const request = text.slice(representedAt, representedAt + 80);
  if (!/(?:决定|做主|拿主意|替我选|告诉我(?:该不该|要不要))/u.test(request)) {
    return false;
  }

  return /(?:卖(?:掉)?(?:房|房子)|买房|处置房产|结婚|离婚|(?:借|贷).{0,8}(?:万|大额)|大额.{0,6}(?:转账|借贷|借款|贷款)|转账.{0,8}(?:万|大额)|手术|治疗方案|停药|用药|起诉|诉讼|签(?:合同|协议))/u.test(
    request,
  );
}

export function detectConversationBoundary(
  text: string,
  personaLabels: string[],
): ConversationBoundary | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const compact = normalized.replace(/\s+/g, "");
  const labels = normalizedLabels(personaLabels ?? []);

  if (detectSelfHarm(compact)) {
    return { kind: "self_harm", reply: SAFETY_REPLY };
  }

  if (isCurrentRealWorldDanger(compact)) {
    return { kind: "real_world_danger", reply: REAL_WORLD_DANGER_REPLY };
  }

  if (isIdentityRealityQuestion(normalized, labels)) {
    return {
      kind: "identity",
      reply: buildIdentityDisclosureReply(labels[0] ?? "这个声音的人"),
    };
  }

  if (isRealWillQuestion(compact)) {
    return { kind: "real_will", reply: REAL_WILL_REPLY };
  }

  if (isCommitmentRequest(compact, labels)) {
    return { kind: "commitment", reply: COMMITMENT_REPLY };
  }

  if (isMajorDecisionRequest(compact, labels)) {
    return { kind: "major_decision", reply: MAJOR_DECISION_REPLY };
  }

  return null;
}
