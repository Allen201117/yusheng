import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function probeAuthConfigured(env: Record<string, string | undefined>) {
  const code = `
    const authModule = await import("./src/lib/auth.ts");
    const { isAuthConfigured } = authModule.default ?? authModule;
    console.log(JSON.stringify({ configured: isAuthConfigured() }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_MODE: "",
      ACCESS_PASSWORD: "",
      ...env,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { configured: boolean };
}

function probeCreateSession(env: Record<string, string | undefined>) {
  const code = `
    const authModule = await import("./src/lib/auth.ts");
    const { createSession } = authModule.default ?? authModule;
    try {
      await createSession("user-1");
      console.log(JSON.stringify({ ok: true }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_MODE: "",
      ACCESS_PASSWORD: "",
      SESSION_SECRET: "",
      NEXT_PHASE: "",
      ...env,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { ok: boolean; message?: string };
}

describe("auth mode", () => {
  it("默认启用认证，不再因为 ACCESS_PASSWORD 为空而免登", () => {
    assert.equal(probeAuthConfigured({}).configured, true);
  });

  it("只有 AUTH_MODE=disabled 时才显式免登", () => {
    assert.equal(probeAuthConfigured({ AUTH_MODE: "disabled" }).configured, false);
  });

  it("生产环境默认 SESSION_SECRET 会拒绝签发 session", () => {
    const result = probeCreateSession({ NODE_ENV: "production" });
    assert.equal(result.ok, false);
    assert.match(result.message || "", /SESSION_SECRET/);
  });
});
