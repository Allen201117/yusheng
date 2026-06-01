import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const testDir = path.join(os.tmpdir(), `yusheng-persona-voice-${Date.now()}-${Math.random()}`);
after(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("persona voice ownership helpers", () => {
  it("按 userId 统计 voiceId 被多少 persona 使用", async () => {
    process.env.DATA_DIR = testDir;
    const { createPersona, countPersonasUsingVoice } = await import("../src/lib/db");

    createPersona({
      id: "p-a-1",
      userId: "user-a",
      name: "A1",
      relation: "亲人",
      voiceId: "voice-shared",
      personaDesc: "",
    });
    createPersona({
      id: "p-a-2",
      userId: "user-a",
      name: "A2",
      relation: "亲人",
      voiceId: "voice-shared",
      personaDesc: "",
    });
    createPersona({
      id: "p-b-1",
      userId: "user-b",
      name: "B1",
      relation: "亲人",
      voiceId: "voice-shared",
      personaDesc: "",
    });

    assert.equal(countPersonasUsingVoice("voice-shared", "user-a"), 2);
    assert.equal(countPersonasUsingVoice("voice-shared", "user-b"), 1);
    assert.equal(countPersonasUsingVoice("voice-missing", "user-a"), 0);
  });
});
