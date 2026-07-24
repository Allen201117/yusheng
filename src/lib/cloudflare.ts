import { getCloudflareContext } from "@opennextjs/cloudflare";

export type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<unknown>;
};

export type D1Database = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<unknown>;
};

export type R2Object = {
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type R2Bucket = {
  put: (key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  get: (key: string) => Promise<R2Object | null>;
  delete: (key: string) => Promise<void>;
};

type RuntimeBindings = { DB?: D1Database; VOICE_FILES?: R2Bucket };

export function runtimeBindings(): Required<RuntimeBindings> {
  const env = getCloudflareContext().env as RuntimeBindings;
  if (!env.DB || !env.VOICE_FILES) {
    throw new Error("线上存储尚未绑定，请稍后重试。");
  }
  return { DB: env.DB, VOICE_FILES: env.VOICE_FILES };
}
