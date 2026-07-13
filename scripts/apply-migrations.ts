import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSql, type SqlExecutor } from "../src/lib/storage/postgres";

export type MigrationFile = { version: string; sql: string };

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export function createMigrationPlan(files: string[], applied: Set<string>): string[] {
  return [...files].sort().filter((file) => !applied.has(file));
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (version) => ({
      version,
      sql: await readFile(path.join(directory, version), "utf8"),
    })),
  );
}

export async function applyMigrations(
  migrations: MigrationFile[],
  executor: SqlExecutor,
): Promise<MigrationResult> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const rows = await executor.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const appliedBefore = new Set(rows.map((row) => row.version));
  const pending = createMigrationPlan(
    migrations.map((migration) => migration.version),
    appliedBefore,
  );
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const version of pending) {
    const migration = byVersion.get(version);
    if (!migration) throw new Error(`Migration ${version} was not loaded`);
    await executor.transaction(async (transaction) => {
      await transaction.query(migration.sql);
      await transaction.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [version],
      );
    });
  }

  return {
    applied: pending,
    skipped: migrations
      .map((migration) => migration.version)
      .filter((version) => appliedBefore.has(version)),
  };
}

async function main() {
  const directory = path.resolve(process.cwd(), "migrations");
  const migrations = await loadMigrationFiles(directory);
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify({ pending: migrations.map((item) => item.version) }, null, 2)}\n`);
    return;
  }
  const result = await applyMigrations(migrations, getSql());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
