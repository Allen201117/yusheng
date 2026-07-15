export function sanitizeProviderErrorPart(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return /^\d{1,20}$/.test(normalized) ? normalized : "";
}

export function providerHttpErrorCode(status: number, providerCode: unknown): string {
  const normalizedStatus = Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 500;
  const numericProviderCode = sanitizeProviderErrorPart(providerCode);
  return `provider_http_${normalizedStatus}${numericProviderCode ? `_${numericProviderCode}` : ""}`;
}

export function stableProviderErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (
      code === "provider_not_configured"
      || code === "provider_invalid_response"
      || code === "provider_timeout"
      || code === "provider_unknown"
      || /^provider_http_[1-5]\d{2}(?:_\d{1,20})?$/.test(code)
    ) return code;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "provider_timeout";
  }
  return "provider_unknown";
}
