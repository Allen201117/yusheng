import Database from "better-sqlite3";
import { constants, createWriteStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveStorageConfig, type StorageEnvironment } from "./storage/config";
import { getSql } from "./storage/postgres";
import { createPostgresRepository } from "./storage/postgresRepository";
import {
  mapRestorationMetricRow,
  RESTORATION_METRIC_SELECT_SQL,
  type RestorationMetricDbRow,
} from "./storage/restorationMetricRows";
import type { RestorationMetricRow } from "./storage/types";

export const MAX_LOCAL_REPORT_DB_BYTES = 256 * 1024 * 1024;

type SnapshotContext = {
  snapshotPath: string;
  sourceSize: number;
};

type SourceFingerprint = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

export type RestorationReportSnapshotOptions = {
  tempRoot?: string;
  onFirstCopyChunk?: (context: SnapshotContext) => void | Promise<void>;
  afterCopy?: (context: SnapshotContext) => void | Promise<void>;
  afterFirstPostCopyFingerprint?: (context: SnapshotContext) => void | Promise<void>;
};

function stableFingerprint(stat: BigIntStats): SourceFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function assertNoActiveSidecars(databasePath: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(`${databasePath}${suffix}`);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    throw new Error("restoration_report_database_active");
  }
}

function assertSameFingerprint(before: SourceFingerprint, after: SourceFingerprint): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("restoration_report_source_changed");
  }
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveSafeTempRoot(databasePath: string, configuredTempRoot?: string): Promise<string> {
  const tempRoot = await realpath(configuredTempRoot || os.tmpdir());
  const [logicalSourceDirectory, physicalDatabasePath] = await Promise.all([
    realpath(path.dirname(databasePath)),
    realpath(databasePath),
  ]);
  const sourceDirectories = new Set([
    logicalSourceDirectory,
    path.dirname(physicalDatabasePath),
  ]);
  if ([...sourceDirectories].some((directory) => isSameOrDescendant(directory, tempRoot))) {
    throw new Error("restoration_report_temp_root_inside_source");
  }
  return tempRoot;
}

async function openLocalDatabaseIfPresent(databasePath: string): Promise<FileHandle | null> {
  try {
    return await open(
      databasePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function listLocalRestorationMetricRows(
  dataDir: string,
  options: RestorationReportSnapshotOptions,
): Promise<RestorationMetricRow[]> {
  const databasePath = path.resolve(dataDir, "yusheng.sqlite");
  const source = await openLocalDatabaseIfPresent(databasePath);
  if (!source) return [];

  let tempDirectory: string | null = null;
  try {
    const beforeStat = await source.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw new Error("restoration_report_database_not_regular");
    }
    const before = stableFingerprint(beforeStat);
    if (before.size <= 0n) {
      throw new Error("restoration_report_database_empty");
    }
    if (before.size > BigInt(MAX_LOCAL_REPORT_DB_BYTES)) {
      throw new Error("restoration_report_database_too_large");
    }
    await assertNoActiveSidecars(databasePath);

    const tempRoot = await resolveSafeTempRoot(databasePath, options.tempRoot);
    tempDirectory = await mkdtemp(path.join(tempRoot, "yusheng-report-"));
    const snapshotPath = path.join(tempDirectory, "yusheng.sqlite");
    const sourceSize = Number(before.size);
    const snapshotContext = { snapshotPath, sourceSize };
    let bytesCopied = 0;
    let firstChunk = true;
    const copyMeter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const forwardChunk = () => {
          bytesCopied += chunk.length;
          if (bytesCopied > sourceSize) {
            callback(new Error("restoration_report_snapshot_exceeded_source"));
            return;
          }
          callback(null, chunk);
        };
        if (!firstChunk) {
          forwardChunk();
          return;
        }
        firstChunk = false;
        Promise.resolve(options.onFirstCopyChunk?.(snapshotContext)).then(
          forwardChunk,
          (error: unknown) => callback(error instanceof Error ? error : new Error("copy_hook_failed")),
        );
      },
    });
    await pipeline(
      source.createReadStream({ autoClose: false, start: 0, end: sourceSize - 1 }),
      copyMeter,
      createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
    );
    if (bytesCopied !== sourceSize) {
      throw new Error("restoration_report_snapshot_incomplete");
    }
    const snapshotStat = await lstat(snapshotPath, { bigint: true });
    if (!snapshotStat.isFile() || snapshotStat.size !== before.size) {
      throw new Error("restoration_report_snapshot_size_mismatch");
    }

    await options.afterCopy?.(snapshotContext);

    const afterCopyA = stableFingerprint(await source.stat({ bigint: true }));
    assertSameFingerprint(before, afterCopyA);
    await options.afterFirstPostCopyFingerprint?.(snapshotContext);
    await assertNoActiveSidecars(databasePath);
    const afterCopyB = stableFingerprint(await source.stat({ bigint: true }));
    assertSameFingerprint(before, afterCopyB);

    const database = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const statement = database.prepare<[], RestorationMetricDbRow>(
        RESTORATION_METRIC_SELECT_SQL,
      );
      if (!statement.readonly) throw new Error("restoration_report_query_not_readonly");
      return statement.all().map(mapRestorationMetricRow);
    } finally {
      database.close();
    }
  } finally {
    try {
      await source.close();
    } finally {
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function listRestorationMetricRowsForReport(
  env: StorageEnvironment = process.env,
  options: RestorationReportSnapshotOptions = {},
): Promise<RestorationMetricRow[]> {
  const config = resolveStorageConfig(env);
  if (config.backend === "local") {
    return listLocalRestorationMetricRows(env.DATA_DIR || "./data", options);
  }

  return createPostgresRepository(getSql(config.databaseUrl)).listRestorationMetricRows();
}
