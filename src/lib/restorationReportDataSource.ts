import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveStorageConfig, type StorageEnvironment } from "./storage/config";
import { getSql } from "./storage/postgres";
import { createPostgresRepository } from "./storage/postgresRepository";
import {
  mapRestorationMetricRow,
  RESTORATION_METRIC_SELECT_SQL,
  type RestorationMetricDbRow,
} from "./storage/restorationMetricRows";
import type { RestorationMetricRow } from "./storage/types";

function listLocalRestorationMetricRows(dataDir: string): RestorationMetricRow[] {
  const databasePath = path.resolve(dataDir, "yusheng.sqlite");
  if (!existsSync(databasePath)) return [];

  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) {
    throw new Error("restoration_report_database_active");
  }

  // better-sqlite3's path-based readonly mode still asks SQLite to create WAL/SHM
  // sidecars. Deserialize a readonly copy instead. A cleanly closed WAL database
  // keeps WAL mode in its header, so change only the in-memory copy back to the
  // rollback format SQLite can deserialize without filesystem access.
  const snapshot = Buffer.from(readFileSync(databasePath));
  if (snapshot[18] === 2 && snapshot[19] === 2) {
    snapshot[18] = 1;
    snapshot[19] = 1;
  }
  const database = new Database(snapshot, { readonly: true });
  try {
    const statement = database.prepare<[], RestorationMetricDbRow>(
      RESTORATION_METRIC_SELECT_SQL,
    );
    if (!statement.readonly) throw new Error("restoration_report_query_not_readonly");
    return statement.all().map(mapRestorationMetricRow);
  } finally {
    database.close();
  }
}

export async function listRestorationMetricRowsForReport(
  env: StorageEnvironment = process.env,
): Promise<RestorationMetricRow[]> {
  const config = resolveStorageConfig(env);
  if (config.backend === "local") {
    return listLocalRestorationMetricRows(env.DATA_DIR || "./data");
  }

  return createPostgresRepository(getSql(config.databaseUrl)).listRestorationMetricRows();
}
