import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStorageConfig } from "../src/lib/storage/config";

describe("resolveStorageConfig", () => {
  it("uses local storage outside production", () => {
    assert.deepEqual(resolveStorageConfig({ NODE_ENV: "test" }), { backend: "local" });
  });

  it("rejects local storage in production", () => {
    assert.throws(
      () => resolveStorageConfig({ NODE_ENV: "production", STORAGE_BACKEND: "local" }),
      /Production requires STORAGE_BACKEND=cloud/,
    );
  });

  it("requires database and private Blob credentials in production", () => {
    assert.throws(
      () => resolveStorageConfig({ NODE_ENV: "production", STORAGE_BACKEND: "cloud" }),
      /DATABASE_URL/,
    );
  });
});
