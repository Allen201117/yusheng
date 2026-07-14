import assert from "node:assert/strict";
import { it } from "node:test";

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
