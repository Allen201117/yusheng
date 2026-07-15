import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { it } from "node:test";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { runRestorationReportCommand } from "../src/lib/restorationReportCommand";
import {
  listRestorationMetricRowsForReport,
  MAX_LOCAL_REPORT_DB_BYTES,
} from "../src/lib/restorationReportDataSource";

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

it("reads an existing migrated SQLite database without changing it or creating sidecars", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-existing-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-temp-root-"));
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
    const rows = await listRestorationMetricRowsForReport(
      {
        DATA_DIR: dataDir,
        NODE_ENV: "test",
        STORAGE_BACKEND: "local",
      },
      { tempRoot },
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(readdirSync(tempRoot), [], "temporary report snapshots must be removed");
    assert.deepEqual(directoryFingerprint(dataDir), before);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("refuses to place a temporary snapshot inside the source data directory", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-temp-source-"));
  try {
    createReportDatabase(dataDir);
    const before = directoryFingerprint(dataDir);
    const command = await runRestorationReportCommand(() =>
      listRestorationMetricRowsForReport(
        {
          DATA_DIR: dataDir,
          NODE_ENV: "test",
          STORAGE_BACKEND: "local",
        },
        { tempRoot: dataDir },
      ),
    );

    assert.equal(command.exitCode, 1);
    assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.deepEqual(directoryFingerprint(dataDir), before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("rejects symlink database paths even when the target is a regular SQLite file", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-symlink-data-"));
  const targetDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-symlink-target-"));
  try {
    createReportDatabase(targetDir);
    symlinkSync(path.join(targetDir, "yusheng.sqlite"), path.join(dataDir, "yusheng.sqlite"));
    const command = await runRestorationReportCommand(() =>
      listRestorationMetricRowsForReport({
        DATA_DIR: dataDir,
        NODE_ENV: "test",
        STORAGE_BACKEND: "local",
      }),
    );

    assert.equal(command.exitCode, 1);
    assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.deepEqual(readdirSync(dataDir), ["yusheng.sqlite"]);
    assert.deepEqual(readdirSync(targetDir), ["yusheng.sqlite"]);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("rejects zero-length and non-regular opened sources before starting a copy", async () => {
  for (const target of ["empty", "device"] as const) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), `yusheng-restoration-${target}-`));
    const databasePath = path.join(dataDir, "yusheng.sqlite");
    let copyStarted = false;
    try {
      if (target === "empty") writeFileSync(databasePath, "");
      else symlinkSync("/dev/null", databasePath);

      const command = await runRestorationReportCommand(() =>
        listRestorationMetricRowsForReport(
          {
            DATA_DIR: dataDir,
            NODE_ENV: "test",
            STORAGE_BACKEND: "local",
          },
          { afterCopy: () => { copyStarted = true; } },
        ),
      );

      assert.equal(command.exitCode, 1, target);
      assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
      assert.equal(copyStarted, false, `${target} must be rejected before copying`);
      assert.deepEqual(readdirSync(dataDir), ["yusheng.sqlite"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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

it("does not treat a permission-denied SQLite file as an empty database", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-permission-"));
  const databasePath = path.join(dataDir, "yusheng.sqlite");
  try {
    createReportDatabase(dataDir);
    chmodSync(databasePath, 0o000);
    const before = statSync(databasePath, { bigint: true });

    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    const after = statSync(databasePath, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(readdirSync(dataDir), ["yusheng.sqlite"]);
  } finally {
    chmodSync(databasePath, 0o600);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("does not treat an invalid data-directory path as an empty database", () => {
  const container = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-enotdir-"));
  const dataDir = path.join(container, "not-a-directory");
  try {
    writeFileSync(dataDir, "not a directory");
    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.equal(readFileSync(dataDir, "utf8"), "not a directory");
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

it("rejects an oversized sparse SQLite file before copying or allocating its contents", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-oversize-"));
  const databasePath = path.join(dataDir, "yusheng.sqlite");
  try {
    writeFileSync(databasePath, "");
    truncateSync(databasePath, MAX_LOCAL_REPORT_DB_BYTES + 1);
    const before = statSync(databasePath, { bigint: true });

    const result = runReport({
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      STORAGE_BACKEND: "local",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    const after = statSync(databasePath, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(readdirSync(dataDir), ["yusheng.sqlite"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("bounds a snapshot to the original size when the source grows during copying", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-grow-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-grow-temp-"));
  const databasePath = path.join(dataDir, "yusheng.sqlite");
  let snapshotSize = -1;
  try {
    createReportDatabase(dataDir);
    const originalSize = statSync(databasePath).size;
    const command = await runRestorationReportCommand(() =>
      listRestorationMetricRowsForReport(
        {
          DATA_DIR: dataDir,
          NODE_ENV: "test",
          STORAGE_BACKEND: "local",
        },
        {
          tempRoot,
          onFirstCopyChunk({ snapshotPath }) {
            appendFileSync(databasePath, Buffer.alloc(1024 * 1024));
            snapshotSize = statSync(snapshotPath).size;
          },
          afterCopy({ snapshotPath }) {
            snapshotSize = statSync(snapshotPath).size;
          },
        },
      ),
    );

    assert.equal(command.exitCode, 1);
    assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.equal(snapshotSize, originalSize);
    assert.ok(snapshotSize <= MAX_LOCAL_REPORT_DB_BYTES);
    assert.deepEqual(readdirSync(tempRoot), [], "grown-source snapshots must be cleaned up");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("discards a copied snapshot when the source changes during the copy window", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-race-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-race-temp-"));
  const concurrent: { database: Database.Database | null } = { database: null };
  try {
    createReportDatabase(dataDir);
    const command = await runRestorationReportCommand(() =>
      listRestorationMetricRowsForReport(
        {
          DATA_DIR: dataDir,
          NODE_ENV: "test",
          STORAGE_BACKEND: "local",
        },
        {
          tempRoot,
          async afterCopy() {
            concurrent.database = new Database(path.join(dataDir, "yusheng.sqlite"));
            concurrent.database.pragma("journal_mode = WAL");
            concurrent.database.exec("CREATE TABLE concurrent_change (id TEXT PRIMARY KEY)");
            concurrent.database.prepare("INSERT INTO concurrent_change (id) VALUES (?)").run("changed");
          },
        },
      ),
    );

    assert.equal(command.exitCode, 1);
    assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.doesNotMatch(command.stdout, /session-existing|evaluator-existing/);
    assert.deepEqual(readdirSync(tempRoot), [], "rejected snapshots must be cleaned up");
  } finally {
    concurrent.database?.close();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("rechecks the source after a WAL closes between the first post-copy fstat and sidecar check", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-wal-close-race-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "yusheng-restoration-wal-close-temp-"));
  const concurrent: { database: Database.Database | null } = { database: null };
  let closedAfterFirstPostCopyFingerprint = false;
  try {
    createReportDatabase(dataDir);
    const command = await runRestorationReportCommand(() =>
      listRestorationMetricRowsForReport(
        {
          DATA_DIR: dataDir,
          NODE_ENV: "test",
          STORAGE_BACKEND: "local",
        },
        {
          tempRoot,
          afterCopy() {
            concurrent.database = new Database(path.join(dataDir, "yusheng.sqlite"));
            concurrent.database.pragma("journal_mode = WAL");
            concurrent.database.exec("CREATE TABLE wal_close_change (id TEXT PRIMARY KEY)");
            concurrent.database.prepare("INSERT INTO wal_close_change (id) VALUES (?)").run("changed");
          },
          afterFirstPostCopyFingerprint() {
            concurrent.database?.close();
            concurrent.database = null;
            closedAfterFirstPostCopyFingerprint = true;
          },
        },
      ),
    );

    assert.equal(closedAfterFirstPostCopyFingerprint, true);
    assert.equal(command.exitCode, 1);
    assert.equal(command.stdout, `${JSON.stringify({ error: "report_unavailable" })}\n`);
    assert.deepEqual(readdirSync(tempRoot), [], "WAL-close race snapshots must be cleaned up");
  } finally {
    concurrent.database?.close();
    rmSync(tempRoot, { recursive: true, force: true });
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
