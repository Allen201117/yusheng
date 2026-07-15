import { it } from "node:test";
import assert from "node:assert/strict";
import {
  providerHttpErrorCode,
  stableProviderErrorCode,
} from "../src/lib/providerErrors";

it("keeps only explicit application categories and numeric provider codes", () => {
  assert.equal(stableProviderErrorCode(Object.assign(new Error(), {
    code: "provider_not_configured",
  })), "provider_not_configured");
  assert.equal(stableProviderErrorCode(Object.assign(new Error(), {
    code: "provider_http_403_10001",
  })), "provider_http_403_10001");
  assert.equal(providerHttpErrorCode(403, 10001), "provider_http_403_10001");
  assert.equal(providerHttpErrorCode(503, "busy"), "provider_http_503");
});

it("never promotes token-like or raw codes into stable storage fields", () => {
  for (const code of [
    "customer_token_sk_live_ABC123",
    "provider_http_503_busy",
    "voice_not_found",
    "raw-upstream-message",
  ]) {
    assert.equal(
      stableProviderErrorCode(Object.assign(new Error("sensitive"), { code })),
      "provider_unknown",
      code,
    );
  }
});
