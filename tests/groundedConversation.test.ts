import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectGroundedContext } from "../src/lib/groundedConversation";

it("selects grounded facts separately from conversation styles", () => {
  const context = selectGroundedContext({
    queryEmbedding: Float32Array.from([1, 0]),
    knowledge: {
      evidence: [
        {
          kind: "fact",
          id: "fact-1",
          content: "她最喜欢桂花茶",
          embedding: Float32Array.from([1, 0]),
          factType: "preference",
          factKey: "favorite_drink",
        },
      ],
      styles: [
        {
          id: "style-1",
          category: "catchphrase",
          content: "慢慢来",
          example: null,
        },
      ],
    },
  });

  assert.equal(context.mode, "grounded");
  assert.deepEqual(
    context.evidence.map(({ kind, id }) => ({ kind, id })),
    [{ kind: "fact", id: "fact-1" }],
  );
  assert.deepEqual(context.styles.map(({ id }) => id), ["style-1"]);
});

describe("grounded evidence ranking", () => {
  it("rejects embedding dimension mismatches instead of silently ranking them", () => {
    assert.throws(
      () =>
        selectGroundedContext({
          queryEmbedding: Float32Array.from([1, 0]),
          knowledge: {
            evidence: [
              {
                kind: "fact",
                id: "bad-dimension",
                content: "不应被静默忽略",
                embedding: Float32Array.from([1, 0, 0]),
                factType: "other",
                factKey: "bad_dimension",
              },
            ],
            styles: [],
          },
        }),
      /embedding_dimension_mismatch/,
    );
  });

  it("deduplicates by kind and id while retaining the same id across kinds", () => {
    const context = selectGroundedContext({
      queryEmbedding: Float32Array.from([1, 0]),
      knowledge: {
        evidence: [
          {
            kind: "fact",
            id: "shared",
            content: "first fact wins",
            embedding: Float32Array.from([0.8, 0]),
            factType: "other",
            factKey: "first",
          },
          {
            kind: "fact",
            id: "shared",
            content: "duplicate fact",
            embedding: Float32Array.from([1, 0]),
            factType: "other",
            factKey: "duplicate",
          },
          {
            kind: "relationship_memory",
            id: "shared",
            content: "same id, different kind",
            embedding: Float32Array.from([0.9, 0]),
            occurredAt: null,
            location: null,
            participants: [],
          },
        ],
        styles: [],
      },
    });

    assert.deepEqual(
      context.evidence.map(({ kind, id, content }) => ({ kind, id, content })),
      [
        { kind: "relationship_memory", id: "shared", content: "same id, different kind" },
        { kind: "fact", id: "shared", content: "first fact wins" },
      ],
    );
  });

  it("caps results at four, sorts ties deterministically, and truncates content", () => {
    const longContent = "长".repeat(2_050);
    const context = selectGroundedContext({
      queryEmbedding: Float32Array.from([1, 0]),
      topK: 99,
      knowledge: {
        evidence: ["e", "d", "c", "b", "a"].map((id) => ({
          kind: "fact" as const,
          id,
          content: id === "a" ? longContent : id,
          embedding: Float32Array.from([1, 0]),
          factType: "other",
          factKey: id,
        })),
        styles: [],
      },
    });

    assert.deepEqual(context.evidence.map(({ id }) => id), ["a", "b", "c", "d"]);
    assert.equal(context.evidence[0].content.length, 2_000);
    assert.equal(longContent.length, 2_050);
  });

  it("normalizes unsafe numeric options without negative slice behavior", () => {
    const knowledge = {
      evidence: [
        {
          kind: "fact" as const,
          id: "fact-1",
          content: "可靠事实",
          embedding: Float32Array.from([0.5, 0]),
          factType: "other",
          factKey: "fact",
        },
      ],
      styles: [],
    };

    assert.equal(
      selectGroundedContext({
        queryEmbedding: Float32Array.from([1, 0]),
        knowledge,
        topK: -1,
        minScore: -1,
      }).evidence.length,
      0,
    );
    assert.equal(
      selectGroundedContext({
        queryEmbedding: Float32Array.from([1, 0]),
        knowledge,
        topK: Number.NaN,
        minScore: Number.NaN,
      }).evidence.length,
      1,
    );
  });

  it("falls back to companionship when no reliable evidence passes the threshold", () => {
    const context = selectGroundedContext({
      queryEmbedding: Float32Array.from([1, 0]),
      knowledge: {
        evidence: [
          {
            kind: "fact",
            id: "low-score",
            content: "低相关内容",
            embedding: Float32Array.from([0.34, 0]),
            factType: "other",
            factKey: "low",
          },
          {
            kind: "fact",
            id: "no-vector",
            content: "没有向量",
            embedding: null,
            factType: "other",
            factKey: "none",
          },
        ],
        styles: [
          { id: "style-only", category: "tone", content: "慢慢说", example: null },
        ],
      },
    });

    assert.equal(context.mode, "companionship");
    assert.deepEqual(context.evidence, []);
    assert.deepEqual(context.styles.map(({ id }) => id), ["style-only"]);
    assert.equal(context.evidence.some(({ id }) => id === "style-only"), false);
  });
});

describe("style budget", () => {
  it("returns at most twenty styles within an exact 8000-character text budget", () => {
    const styles = Array.from({ length: 21 }, (_, index) => ({
      id: `style-${String(index).padStart(2, "0")}`,
      category: "tone",
      content: "内".repeat(300),
      example: "例".repeat(150),
    }));

    const context = selectGroundedContext({
      queryEmbedding: Float32Array.from([1, 0]),
      knowledge: { evidence: [], styles },
    });
    const total = context.styles.reduce(
      (sum, style) => sum + style.content.length + (style.example?.length ?? 0),
      0,
    );

    assert.equal(context.styles.length, 18);
    assert.equal(total, 8_000);
    assert.equal(context.styles.at(-1)?.content.length, 300);
    assert.equal(context.styles.at(-1)?.example?.length, 50);
  });

  it("does not return empty styles and does not mutate any input objects", () => {
    const evidenceContent = "证".repeat(2_050);
    const knowledge = {
      evidence: [
        {
          kind: "fact" as const,
          id: "fact-1",
          content: evidenceContent,
          embedding: Float32Array.from([1, 0]),
          factType: "other",
          factKey: "fact",
        },
      ],
      styles: [
        { id: "empty", category: "tone", content: "", example: null },
        { id: "example-only", category: "tone", content: "", example: "举例" },
        { id: "normal", category: "tone", content: "慢慢来", example: null },
      ],
    };

    const context = selectGroundedContext({
      queryEmbedding: Float32Array.from([1, 0]),
      knowledge,
    });

    assert.deepEqual(context.styles.map(({ id }) => id), ["example-only", "normal"]);
    assert.equal(knowledge.evidence[0].content, evidenceContent);
    assert.equal(knowledge.styles[1].content, "");
    assert.equal(knowledge.styles[1].example, "举例");
    assert.notEqual(context.evidence[0], knowledge.evidence[0]);
    assert.notEqual(context.styles[0], knowledge.styles[1]);
  });
});
