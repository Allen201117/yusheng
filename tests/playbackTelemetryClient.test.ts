import { it } from "node:test";
import assert from "node:assert/strict";
import { OrderedPlaybackQueue } from "../src/lib/orderedPlaybackQueue";
import {
  createTrackedPlaybackTelemetry,
  playAudioWithTelemetry,
  type TelemetryAudioElement,
} from "../src/lib/playbackTelemetryClient";

type CapturedRequest = { url: string; body: Record<string, unknown> };

function telemetryFixture(statuses: number[] = [201, 201, 201, 201]) {
  const requests: CapturedRequest[] = [];
  let id = 0;
  let now = 100;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(null, { status: statuses.shift() ?? 201 });
  };
  const response = new Response(new Blob(["audio"]), {
    headers: { "X-TTS-Attempt-ID": "attempt-1" },
  });
  const telemetry = createTrackedPlaybackTelemetry(response, true, {
    fetchImpl: fetchImpl as typeof fetch,
    randomUUID: () => `event-${++id}`,
    nowMs: () => now += 10.4,
    wait: async () => {},
  });
  return { telemetry, requests };
}

class SuccessfulAudio implements TelemetryAudioElement {
  onloadeddata: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  async play(): Promise<void> {
    this.onloadeddata?.();
    setTimeout(() => this.onended?.(), 0);
  }
}

it("carries the tracked TTS response header through the queue and sends the success events", async () => {
  const f = telemetryFixture();
  assert.ok(f.telemetry);
  const queue = new OrderedPlaybackQueue(async (audio: SuccessfulAudio) => {
    await playAudioWithTelemetry(audio, f.telemetry, () => {});
  });
  queue.enqueue(Promise.resolve(new SuccessfulAudio()));
  await queue.whenIdle();
  await f.telemetry!.whenSettled();

  assert.deepEqual(f.requests.map((request) => request.url), [
    "/api/playback-event",
    "/api/playback-event",
    "/api/playback-event",
  ]);
  assert.deepEqual(
    f.requests.map((request) => request.body.eventType).sort(),
    ["audio_ready", "play_completed", "play_started", "play_failed"].filter((type) => type !== "play_failed"),
  );
  assert.equal(f.requests.length, 3);
  for (const request of f.requests) {
    assert.deepEqual(Object.keys(request.body).sort(), [
      "clientElapsedMs", "eventId", "eventType", "ttsAttemptId",
    ]);
    assert.equal(request.body.ttsAttemptId, "attempt-1");
    assert.equal(Number.isInteger(request.body.clientElapsedMs), true);
    assert.ok(Number(request.body.clientElapsedMs) >= 0);
    assert.ok(Number(request.body.clientElapsedMs) <= 300000);
  }
});

it("reports play_failed without exposing the browser error", async () => {
  const f = telemetryFixture([201]);
  assert.ok(f.telemetry);
  const audio: TelemetryAudioElement = {
    onloadeddata: null,
    onended: null,
    onerror: null,
    async play() { throw new Error("raw browser audio error"); },
  };
  await assert.rejects(playAudioWithTelemetry(audio, f.telemetry, () => {}), /raw browser audio error/);
  await f.telemetry!.whenSettled();
  assert.deepEqual(f.requests.map((request) => request.body.eventType), ["play_failed"]);
  assert.doesNotMatch(JSON.stringify(f.requests), /raw browser audio error/);
});

it("does not create qualifying telemetry for untracked manual replay", async () => {
  let calls = 0;
  const untrackedResponse = new Response(new Blob(["audio"]), {
    headers: { "X-TTS-Attempt-ID": "attempt-forged" },
  });
  const telemetry = createTrackedPlaybackTelemetry(untrackedResponse, false, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(telemetry, null);
  await playAudioWithTelemetry(new SuccessfulAudio(), telemetry, () => {});
  assert.equal(calls, 0);
});

it("retries at most once with the same stable event id", async () => {
  const f = telemetryFixture([500, 201]);
  assert.ok(f.telemetry);
  assert.equal(await f.telemetry!.emit("play_started"), true);
  assert.equal(await f.telemetry!.emit("play_started"), true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body.eventId, f.requests[1].body.eventId);
  assert.equal(f.requests[0].body.clientElapsedMs, f.requests[1].body.clientElapsedMs);
});

it("rejects missing, padded or oversized attempt headers", () => {
  for (const value of [null, " attempt-1", `attempt-${"x".repeat(200)}`]) {
    const response = {
      headers: { get: () => value },
    } as unknown as Pick<Response, "headers">;
    assert.equal(createTrackedPlaybackTelemetry(response, true), null);
  }
});

it("clamps elapsed time and lets playback finish when telemetry exhausts retries", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let eventSequence = 0;
  const telemetry = createTrackedPlaybackTelemetry(
    new Response(null, { headers: { "X-TTS-Attempt-ID": "attempt-1" } }),
    true,
    {
      fetchImpl: (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 500 });
      }) as typeof fetch,
      randomUUID: () => `event-clamped-${++eventSequence}`,
      nowMs: (() => {
        const values = [0, 999_999];
        return () => values.shift() ?? 999_999;
      })(),
      wait: async () => {},
    },
  );
  assert.ok(telemetry);
  await playAudioWithTelemetry(new SuccessfulAudio(), telemetry, () => {});
  await telemetry!.whenSettled();
  assert.ok(requests.length >= 2);
  assert.equal(requests.every((request) => request.clientElapsedMs === 300000), true);
  const grouped = new Map<string, number>();
  for (const request of requests) {
    grouped.set(String(request.eventType), (grouped.get(String(request.eventType)) ?? 0) + 1);
  }
  assert.equal(Array.from(grouped.values()).every((count) => count === 2), true);
});

it("cancelling playback does not claim completion or failure", async () => {
  const f = telemetryFixture();
  assert.ok(f.telemetry);
  const audio: TelemetryAudioElement = {
    onloadeddata: null,
    onended: null,
    onerror: null,
    async play() {},
  };
  await playAudioWithTelemetry(audio, f.telemetry, () => {}, (cancel) => cancel());
  await f.telemetry!.whenSettled();
  assert.deepEqual(f.requests, []);
});
