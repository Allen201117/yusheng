import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectConversationBoundary } from "../src/lib/conversationBoundary";
import { SAFETY_REPLY } from "../src/lib/safety";

describe("detectConversationBoundary", () => {
  it("detects safety and reality boundaries in priority order", () => {
    assert.equal(detectConversationBoundary("你真的是妈妈本人吗", ["妈妈"])?.kind, "identity");
    assert.equal(
      detectConversationBoundary("她临终前是不是希望我卖掉房子", ["妈妈"])?.kind,
      "real_will",
    );
    assert.equal(
      detectConversationBoundary("你替她保证我一定会成功吗", ["妈妈"])?.kind,
      "commitment",
    );
    assert.equal(detectConversationBoundary("我想死", ["妈妈"])?.kind, "self_harm");
    assert.equal(
      detectConversationBoundary("他正在打我，我躲在房间里", ["妈妈"])?.kind,
      "real_world_danger",
    );
    assert.equal(
      detectConversationBoundary("我现在胸口剧痛喘不上气", ["妈妈"])?.kind,
      "real_world_danger",
    );
    assert.equal(
      detectConversationBoundary("有人正在打我，我不想活了", ["妈妈"])?.kind,
      "self_harm",
    );
  });

  it("detects explicit current knife attacks without treating every knife mention as danger", () => {
    for (const text of [
      "救命，他拿刀架在我脖子上",
      "我现在被人拿刀架在脖子上",
      "他正在拿刀捅我",
      "他正在拿刀刺我",
      "他正在拿刀砍我",
    ]) {
      assert.equal(
        detectConversationBoundary(text, ["妈妈"])?.kind,
        "real_world_danger",
        text,
      );
    }
  });

  it("excludes past trauma and deceased medical history unless danger is current", () => {
    for (const text of [
      "妈妈去世前大出血，后来没救回来",
      "他以前持刀威胁我，现在想起来还害怕",
      "他以前持刀威胁我，现在想起来还在害怕",
      "我被困在房间里时，妈妈一直陪我说话",
      "小时候我被困在储物间，后来爸爸找到了我",
      "小时候我被困在房间出不去，后来有人找到了我",
      "当时我胸口剧痛喘不上气，后来去了医院",
    ]) {
      assert.equal(detectConversationBoundary(text, ["妈妈"]), null, text);
    }

    assert.equal(
      detectConversationBoundary("以前威胁过我，但他现在拿刀堵在门口", ["妈妈"])?.kind,
      "real_world_danger",
    );
  });

  it("detects requests to make major decisions for the person", () => {
    for (const text of [
      "你替妈妈决定要不要卖房",
      "请你代替她决定我该不该结婚",
      "你替妈妈决定要不要借五十万元",
      "你代她决定这笔大额转账要不要做",
      "你替她决定我要不要做这个手术",
      "请代替妈妈决定要不要起诉他",
    ]) {
      assert.equal(detectConversationBoundary(text, ["妈妈"])?.kind, "major_decision", text);
    }
  });

  it("does not turn ordinary memories, conflict, discomfort, or personal promises into boundaries", () => {
    for (const text of [
      "我想起妈妈去世前和我一起包饺子",
      "她临终前最爱喝桂花茶",
      "她去世前希望我照顾好自己",
      "我昨天和他吵架了",
      "我们刚才争吵了几句，现在已经冷静了",
      "我听说他以前持刀威胁别人",
      "我今天有点头疼",
      "我保证完成今天的任务",
      "请你替妈妈整理她写过的承诺书",
      "妈妈以前决定卖掉那套房",
    ]) {
      assert.equal(detectConversationBoundary(text, ["妈妈"]), null, text);
    }
  });

  it("returns fixed, non-personified replies for every boundary kind", () => {
    const cases = [
      ["我想死", "我不想活了", "self_harm"],
      ["他正在打我，我被困在房间", "有人持刀威胁我", "real_world_danger"],
      ["你真的是妈妈本人吗", "你是不是妈妈", "identity"],
      ["她的遗愿是不是让我卖房", "她临终前是不是希望我结婚", "real_will"],
      ["你替她保证我会成功吗", "请代表妈妈承诺永远支持我", "commitment"],
      ["你替妈妈决定要不要卖房", "你代她决定我要不要结婚", "major_decision"],
    ] as const;

    for (const [first, second, kind] of cases) {
      const firstResult = detectConversationBoundary(first, ["妈妈"]);
      const secondResult = detectConversationBoundary(second, ["妈妈"]);
      assert.equal(firstResult?.kind, kind);
      assert.equal(secondResult?.kind, kind);
      assert.equal(firstResult?.reply, secondResult?.reply, kind);
      assert.doesNotMatch(
        firstResult?.reply ?? "",
        /(?:^|[。！!])我(?:是(?:你)?妈妈|替她|代表她)/u,
      );
    }

    assert.equal(detectConversationBoundary("我想死", ["妈妈"])?.reply, SAFETY_REPLY);

    const dangerReply = detectConversationBoundary("他正在打我，我被困在房间", ["妈妈"])?.reply ?? "";
    assert.match(dangerReply, /离开|躲避/u);
    assert.match(dangerReply, /身边|真人/u);
    assert.match(dangerReply, /110/);
    assert.match(dangerReply, /120/);

    const medicalReply = detectConversationBoundary("我现在胸口剧痛喘不上气", ["妈妈"])?.reply ?? "";
    assert.match(medicalReply, /120/);
    assert.doesNotMatch(medicalReply, /(?:你(?:得了|患有)|这是.{0,10}(?:病|症)|诊断为)/u);

    const identityReply = detectConversationBoundary("你真的是妈妈本人吗", ["妈妈"])?.reply ?? "";
    assert.match(identityReply, /AI/u);
    assert.match(identityReply, /不是妈妈本人|不是.*本人/u);
  });

  it("normalizes whitespace and safely ignores empty input and labels", () => {
    assert.equal(detectConversationBoundary("  我 想 死  ", ["妈妈"])?.kind, "self_harm");
    assert.equal(detectConversationBoundary("   ", ["", "  "]), null);
  });
});
