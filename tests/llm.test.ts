import assert from "node:assert/strict";
import { after, before, it } from "node:test";

import { chatComplete, LlmProviderError } from "../src/lib/llm";

const originalFetch = globalThis.fetch;

before(() => {
  process.env.SILICONFLOW_API_KEY = "synthetic-test-key";
});

after(() => {
  delete process.env.SILICONFLOW_API_KEY;
  globalThis.fetch = originalFetch;
});

it("passes the caller AbortSignal into the real provider fetch", async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify({ choices: [{ message: { content: " 完成 " } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  assert.equal(await chatComplete([{ role: "user", content: "test" }], controller.signal), "完成");
  assert.equal(fetchCalls, 1);
});

it("normalizes network, HTTP and malformed response failures without raw bodies", async () => {
  const scenarios: Array<{
    id: string;
    fetch: typeof fetch;
    category: string;
    status: number | null;
  }> = [
    {
      id: "network",
      fetch: async () => { throw new TypeError("SECRET network detail"); },
      category: "network",
      status: null,
    },
    ...[401, 429, 503].map((status) => ({
      id: `http_${status}`,
      fetch: async () => new Response("SECRET provider raw body", { status }),
      category: "http",
      status,
    })),
    {
      id: "invalid_json",
      fetch: async () => new Response("not-json SECRET", { status: 200 }),
      category: "response",
      status: null,
    },
    {
      id: "invalid_shape",
      fetch: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      category: "response",
      status: null,
    },
  ];

  for (const scenario of scenarios) {
    globalThis.fetch = scenario.fetch;
    await assert.rejects(
      chatComplete([{ role: "user", content: scenario.id }]),
      (error: unknown) => {
        assert.ok(error instanceof LlmProviderError, scenario.id);
        assert.equal(error.category, scenario.category, scenario.id);
        assert.equal(error.status, scenario.status, scenario.id);
        assert.doesNotMatch(error.message, /SECRET|raw body|network detail/, scenario.id);
        return true;
      },
    );
  }
});
