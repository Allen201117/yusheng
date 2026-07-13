export type StorageEnvironment = Record<string, string | undefined>;

export type StorageConfig =
  | { backend: "local" }
  | { backend: "cloud"; databaseUrl: string; blobToken: string };

export function resolveStorageConfig(env: StorageEnvironment): StorageConfig {
  const production = env.NODE_ENV === "production";
  const backend = env.STORAGE_BACKEND || (production ? "" : "local");

  if (backend === "local") {
    if (production) {
      throw new Error("Production requires STORAGE_BACKEND=cloud");
    }
    return { backend: "local" };
  }

  if (backend !== "cloud") {
    throw new Error("STORAGE_BACKEND must be local or cloud");
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for cloud storage");
  }
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for cloud storage");
  }

  return {
    backend: "cloud",
    databaseUrl: env.DATABASE_URL,
    blobToken: env.BLOB_READ_WRITE_TOKEN,
  };
}

export function getStorageConfig(): StorageConfig {
  return resolveStorageConfig(process.env);
}
