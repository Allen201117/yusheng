import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

it("runs Vercel Functions beside Singapore storage", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.regions, ["sin1"]);
});
