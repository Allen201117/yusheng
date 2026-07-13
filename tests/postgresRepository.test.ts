import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyMigrations, createMigrationPlan } from "../scripts/apply-migrations";
import type { SqlExecutor } from "../src/lib/storage/postgres";

it("applies only migrations missing from schema_migrations", () => {
  const plan = createMigrationPlan(["001_production_foundation.sql"], new Set());
  assert.deepEqual(plan, ["001_production_foundation.sql"]);
  assert.deepEqual(createMigrationPlan(plan, new Set(plan)), []);
});

it("defines the complete durable schema with vector memory storage", async () => {
  const sql = await readFile(
    new URL("../migrations/001_production_foundation.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "schema_migrations",
    "users",
    "verification_codes",
    "voice_profiles",
    "personas",
    "memories",
    "messages",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(sql, /embedding vector\(1024\)/);
  assert.match(sql, /voice_id text NOT NULL REFERENCES voice_profiles\(id\) ON DELETE RESTRICT/);
});

it("applies a pending migration and records it in one transaction", async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let transactions = 0;
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.includes("SELECT version")) return [] as T[];
      return [] as T[];
    },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(executor);
    },
  };

  const result = await applyMigrations(
    [{ version: "001.sql", sql: "CREATE TABLE example (id text);" }],
    executor,
  );

  assert.deepEqual(result, { applied: ["001.sql"], skipped: [] });
  assert.equal(transactions, 1);
  assert.ok(queries.some((entry) => entry.text.includes("CREATE TABLE example")));
  assert.ok(queries.some((entry) => entry.text.includes("INSERT INTO schema_migrations")));
});
