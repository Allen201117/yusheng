import Database from "better-sqlite3";
import { createWriteStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type SourceFingerprint = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

export type RestorationReportSnapshotOptions = {
  tempRoot?: string;
  afterCopy?: () => void | Promise<void>;
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
    return await open(databasePath, "r");
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
    const before = stableFingerprint(await source.stat({ bigint: true }));
    if (before.size > BigInt(MAX_LOCAL_REPORT_DB_BYTES)) {
      throw new Error("restoration_report_database_too_large");
    }
    await assertNoActiveSidecars(databasePath);

    const tempRoot = await resolveSafeTempRoot(databasePath, options.tempRoot);
    tempDirectory = await mkdtemp(path.join(tempRoot, "yusheng-report-"));
    const snapshotPath = path.join(tempDirectory, "yusheng.sqlite");
    await pipeline(
      source.createReadStream({ autoClose: false, start: 0 }),
      createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
    );

    await options.afterCopy?.();

    const after = stableFingerprint(await source.stat({ bigint: true }));
    assertSameFingerprint(before, after);
    await assertNoActiveSidecars(databasePath);

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
