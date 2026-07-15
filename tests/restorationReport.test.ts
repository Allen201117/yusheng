import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { it } from "node:test";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

function runReport(env: Record<string, string>) {
  return spawnSync("npm", ["run", "--silent", "report:restoration"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false", ...env },
  });
}

function directoryFingerprint(directory: string) {
  return readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    const stat = statSync(filePath);
    return {
      name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    };
  });
}

function createReportDatabase(dataDir: string) {
  const database = new Database(path.join(dataDir, "yusheng.sqlite"));
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE conversation_sessions (
      id TEXT PRIMARY KEY,
      evaluator_user_id TEXT NOT NULL,
      cohort TEXT NOT NULL
    );
    CREATE TABLE conversation_feedback (
      session_id TEXT NOT NULL,
      evaluator_user_id TEXT NOT NULL,
      voice_similarity INTEGER NOT NULL,
      expression_similarity INTEGER NOT NULL,
      emotion_fit INTEGER NOT NULL,
      fact_trust INTEGER NOT NULL,
      discomfort INTEGER NOT NULL,
      major_fabrication INTEGER NOT NULL,
      identity_impersonation INTEGER NOT NULL,
      authorization_violation INTEGER NOT NULL
    );
    INSERT INTO conversation_sessions (id, evaluator_user_id, cohort)
    VALUES ('session-existing', 'evaluator-existing', 'deceased');
    INSERT INTO conversation_feedback
      (session_id, evaluator_user_id, voice_similarity, expression_similarity,
       emotion_fit, fact_trust, discomfort, major_fabrication,
       identity_impersonation, authorization_violation)
    VALUES
      ('session-existing', 'evaluator-existing', 5, 4, 4, 5, 2, 0, 0, 0);
  `);
  database.close();
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
    const expected = {
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
    };
    assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.doesNotMatch(result.stdout, /yusheng-v2|report:restoration|node --import/);
    assert.deepEqual(readdirSync(dataDir), [], "an empty report must not create a database");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("reads an existing migrated SQLite database without changing it or creating sidecars", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-existing-"));
  try {
    createReportDatabase(dataDir);
    const before = directoryFingerprint(dataDir);

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
        evaluatorCount: 1,
        sessionCount: 1,
        effectiveSessionCount: 1,
        effectiveRate: 1,
        meetsInitialGate: false,
      },
      bothCohortsMeetInitialGate: false,
    });
    assert.deepEqual(directoryFingerprint(dataDir), before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("fails stably on an unmigrated SQLite database without upgrading or changing it", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-legacy-"));
  try {
    const legacy = new Database(path.join(dataDir, "yusheng.sqlite"));
    legacy.exec("CREATE TABLE legacy_only (id TEXT PRIMARY KEY)");
    legacy.close();
    const before = directoryFingerprint(dataDir);

    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.deepEqual(directoryFingerprint(dataDir), before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("fails stably without touching an active WAL database or its sidecars", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-active-"));
  const active = new Database(path.join(dataDir, "yusheng.sqlite"));
  try {
    active.pragma("journal_mode = WAL");
    active.exec("CREATE TABLE active_write (id TEXT PRIMARY KEY)");
    active.prepare("INSERT INTO active_write (id) VALUES (?)").run("write-in-wal");
    const before = directoryFingerprint(dataDir);
    assert.ok(before.some((file) => file.name.endsWith("-wal")));
    assert.ok(before.some((file) => file.name.endsWith("-shm")));

    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.deepEqual(directoryFingerprint(dataDir), before);
  } finally {
    active.close();
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
  assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
  assert.deepEqual(JSON.parse(result.stdout), { error: "report_unavailable" });
  assert.doesNotMatch(result.stdout, /private-user|private-password|example\.invalid|private-db/);
});
