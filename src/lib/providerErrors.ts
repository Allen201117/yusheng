export function sanitizeProviderErrorPart(value: unknown): string {
  const normalized = String(value || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return normalized.slice(0, 40) || "unknown";
}

export function providerHttpErrorCode(status: number, providerCode: unknown): string {
  return `provider_http_${status}_${sanitizeProviderErrorPart(providerCode)}`;
}

export function stableProviderErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(code)) return code;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "provider_timeout";
  }
  return "provider_unknown";
}
