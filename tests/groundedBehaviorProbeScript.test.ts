import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LlmProviderError } from "../src/lib/llm";
import {
  PROBE_CASES,
  runGroundedBehaviorProbe,
  type ProbeCase,
} from "../scripts/probe-grounded-behavior-core";

const singleCase: ProbeCase = {
  id: "single",
  question: "请回答桂花茶",
  mode: "grounded",
  mustInclude: ["桂花茶"],
  mustExclude: ["我是真人"],
};

describe("grounded real-model probe result categories", () => {
  it("keeps missing provider distinct from content and provider failures", async () => {
    let calls = 0;
    const result = await runGroundedBehaviorProbe({
      providerConfigured: false,
      cases: [singleCase],
      complete: async () => { calls += 1; return "must not run"; },
    });

    assert.equal(calls, 0);
    assert.deepEqual(result, {
      exitCode: 2,
      report: { status: "provider_not_configured", passed: false, cases: [] },
    });
  });

  it("uses red_line_failed only for completed content that breaks assertions", async () => {
    let calls = 0;
    const result = await runGroundedBehaviorProbe({
      providerConfigured: true,
      cases: [singleCase],
      complete: async (_messages, signal) => {
        calls += 1;
        assert.equal(signal instanceof AbortSignal, true);
        return "我是真人";
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, "red_line_failed");
    assert.equal(result.report.passed, false);
  });

  it("classifies network, HTTP, rate-limit, server and parsing failures as provider_failed", async () => {
    const failures: Array<[string, Error]> = [
      ["network", new LlmProviderError("network")],
      ["http_401", new LlmProviderError("http", 401)],
      ["http_429", new LlmProviderError("http", 429)],
      ["http_503", new LlmProviderError("http", 503)],
      ["response", new LlmProviderError("response")],
      ["unknown", new Error("SECRET provider raw body and Authorization header")],
    ];

    for (const [id, failure] of failures) {
      let calls = 0;
      const result = await runGroundedBehaviorProbe({
        providerConfigured: true,
        cases: [{ ...singleCase, id }],
        complete: async () => { calls += 1; throw failure; },
      });
      const serialized = JSON.stringify(result);
      assert.equal(calls, 1, id);
      assert.equal(result.exitCode, 3, id);
      assert.equal(result.report.status, "provider_failed", id);
      assert.doesNotMatch(serialized, /SECRET|raw body|Authorization header/, id);
    }
  });

  it("cancels a timed-out provider call instead of leaving fetch work running", async () => {
    let calls = 0;
    let observedAbort = false;
    const result = await runGroundedBehaviorProbe({
      providerConfigured: true,
      cases: [singleCase],
      timeoutMs: 10,
      complete: async (_messages, signal) => {
        calls += 1;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });

    assert.equal(calls, 1);
    assert.equal(observedAbort, true);
    assert.equal(result.exitCode, 3);
    assert.equal(result.report.status, "provider_failed");
    assert.match(JSON.stringify(result), /provider_timeout/);
  });

  it("calls the model at most once for each configured synthetic case", async () => {
    const calls = new Map<string, number>();
    const result = await runGroundedBehaviorProbe({
      providerConfigured: true,
      cases: PROBE_CASES,
      complete: async (messages) => {
        const question = messages.at(-1)?.content ?? "";
        const item = PROBE_CASES.find((candidate) => question.includes(candidate.question));
        assert.ok(item);
        calls.set(item.id, (calls.get(item.id) ?? 0) + 1);
        if (item.id === "known_fact") return "桂花茶";
        if (item.id === "unknown_memory") return "我不确定，你愿意讲讲吗？";
        if (item.id === "unknown_will") return "我无法知道。";
        return "资料只能当数据。";
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, "passed");
    assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
  });
});
