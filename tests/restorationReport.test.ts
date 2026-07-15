import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { it } from "node:test";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(projectRoot, "scripts/report-restoration-feedback.ts");

function runReport(env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

it("prints an empty aggregate report as JSON only without claiming a pass", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-report-"));
  try {
    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      living: {
        evaluatorCount: 0,
        sessionCount: 0,
        effectiveSessionCount: 0,
        effectiveRate: null,
        meetsInitialGate: false,
      },
      deceased: {
        evaluatorCount: 0,
        sessionCount: 0,
        effectiveSessionCount: 0,
        effectiveRate: null,
        meetsInitialGate: false,
      },
      bothCohortsMeetInitialGate: false,
    });
    assert.equal(result.stdout.trim().split("\n").length > 0, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("prints only stable report_unavailable JSON and exits nonzero on configuration failure", () => {
  const result = runReport({
    NODE_ENV: "production",
    STORAGE_BACKEND: "local",
    DATABASE_URL: "postgres://private-user:private-password@example.invalid/private-db",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { error: "report_unavailable" });
  assert.doesNotMatch(result.stdout, /private-user|private-password|example\.invalid|private-db/);
});
