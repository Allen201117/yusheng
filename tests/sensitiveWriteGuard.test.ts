import { it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { requireSameOrigin } from "../src/lib/sensitiveWriteGuard";

function request(origin?: string) {
  return new NextRequest("https://preview.example.com/api/voice/authorization", {
    method: "POST",
    headers: origin ? { Origin: origin } : undefined,
  });
}

it("accepts an exact configured app origin", () => {
  assert.equal(requireSameOrigin(request("https://app.example.com"), {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.example.com",
  }), null);
});

it("accepts a Vercel deployment origin without trusting the request host", () => {
  assert.equal(requireSameOrigin(request("https://preview.example.com"), {
    NODE_ENV: "production",
    VERCEL_URL: "preview.example.com",
  }), null);
});

it("rejects missing and cross-origin production writes", async () => {
  const missing = requireSameOrigin(request(), {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.example.com",
  });
  assert.equal(missing?.status, 403);
  assert.equal((await missing?.json()).code, "ORIGIN_REQUIRED");

  const mismatch = requireSameOrigin(request("https://evil.example"), {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.example.com",
  });
  assert.equal(mismatch?.status, 403);
  assert.equal((await mismatch?.json()).code, "ORIGIN_MISMATCH");
});

it("fails closed when production has no trusted origin configuration", async () => {
  const response = requireSameOrigin(request("https://preview.example.com"), {
    NODE_ENV: "production",
  });
  assert.equal(response?.status, 503);
  assert.equal((await response?.json()).code, "ORIGIN_NOT_CONFIGURED");
});

it("uses the request URL only for local development", () => {
  const local = new NextRequest("http://localhost:3000/api/voice/authorization", {
    method: "DELETE",
    headers: { Origin: "http://localhost:3000" },
  });
  assert.equal(requireSameOrigin(local, { NODE_ENV: "development" }), null);
});
