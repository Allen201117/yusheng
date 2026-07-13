import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStorageConfig } from "../src/lib/storage/config";
import { selectRepository } from "../src/lib/storage/repository";
import type { AppRepository } from "../src/lib/storage/types";

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

it("selects exactly one repository without constructing the other backend", () => {
  const local = {} as AppRepository;
  const cloud = {} as AppRepository;
  let localCalls = 0;
  let cloudCalls = 0;

  assert.equal(
    selectRepository(
      { backend: "local" },
      () => { localCalls += 1; return local; },
      () => { cloudCalls += 1; return cloud; },
    ),
    local,
  );
  assert.equal(localCalls, 1);
  assert.equal(cloudCalls, 0);
});
