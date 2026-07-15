import { it } from "node:test";
import assert from "node:assert/strict";
import { OrderedPlaybackQueue } from "../src/lib/orderedPlaybackQueue";
import {
  cancelPlaybackLifecycle,
  createTrackedPlaybackTelemetry,
  flushPendingPlaybackEvents,
  installPlaybackTelemetryFlushListeners,
  playAudioItemLifecycle,
  playAudioWithTelemetry,
  type PlaybackCancellationSlot,
  type TelemetryAudioElement,
} from "../src/lib/playbackTelemetryClient";

type CapturedRequest = { url: string; body: Record<string, unknown>; keepalive: boolean };

function telemetryFixture(statuses: number[] = [201, 201, 201, 201]) {
  const requests: CapturedRequest[] = [];
  let id = 0;
  let now = 100;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      keepalive: init?.keepalive === true,
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
  assert.equal(f.requests[0].keepalive, true);
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
  flushPendingPlaybackEvents(() => true);
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

class PendingAudio implements TelemetryAudioElement {
  onloadeddata: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  async play(): Promise<void> {}
}

it("reset cannot let an old finally clear the new playback cancel handle", async () => {
  const slot: PlaybackCancellationSlot = { current: null };
  const oldAudio = new PendingAudio();
  const old = playAudioItemLifecycle({
    audio: oldAudio,
    telemetry: null,
    onPlaybackStarted: () => {},
    prepareAudio: () => {},
    pauseAfterMs: 0,
    cancellationSlot: slot,
  });
  cancelPlaybackLifecycle(slot);

  const newAudio = new PendingAudio();
  const current = playAudioItemLifecycle({
    audio: newAudio,
    telemetry: null,
    onPlaybackStarted: () => {},
    prepareAudio: () => {},
    pauseAfterMs: 0,
    cancellationSlot: slot,
  });
  assert.equal(await old, "cancelled");
  assert.notEqual(slot.current, null);
  cancelPlaybackLifecycle(slot);
  assert.equal(await current, "cancelled");
  assert.equal(slot.current, null);
});

it("reset during the sentence pause cancels the timer immediately", async () => {
  const slot: PlaybackCancellationSlot = { current: null };
  const audio = new PendingAudio();
  let cleared = 0;
  let timerCallback: (() => void) | null = null;
  const running = playAudioItemLifecycle({
    audio,
    telemetry: null,
    onPlaybackStarted: () => {},
    prepareAudio: () => {},
    pauseAfterMs: 10_000,
    cancellationSlot: slot,
    setTimeoutFn: (callback) => {
      timerCallback = callback;
      return 7 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => { cleared += 1; },
  });
  audio.onended?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(timerCallback);
  cancelPlaybackLifecycle(slot);
  assert.equal(await running, "cancelled");
  assert.equal(cleared, 1);
  assert.equal(slot.current, null);
});

it("uses keepalive and aborts each telemetry request after a bounded timeout", async () => {
  let aborted = 0;
  const requestOptions: RequestInit[] = [];
  const telemetry = createTrackedPlaybackTelemetry(
    new Response(null, { headers: { "X-TTS-Attempt-ID": "attempt-timeout" } }),
    true,
    {
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        requestOptions.push(init ?? {});
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as typeof fetch,
      randomUUID: () => "event-timeout",
      requestTimeoutMs: 1,
      wait: async () => {},
    },
  );
  assert.ok(telemetry);
  assert.equal(await telemetry!.emit("play_started"), false);
  assert.equal(aborted, 2);
  assert.equal(requestOptions.every((options) => options.keepalive === true), true);
  assert.equal(requestOptions.every((options) => options.signal instanceof AbortSignal), true);
  flushPendingPlaybackEvents(() => true);
});

it("flushes bounded pending events on pagehide with the original safe body and cleans listeners", async () => {
  const handlers = new Map<string, () => void>();
  const removed: string[] = [];
  const target = {
    addEventListener(type: string, handler: () => void) { handlers.set(type, handler); },
    removeEventListener(type: string) { removed.push(type); handlers.delete(type); },
  };
  const beacons: Array<{ url: string; body: Blob }> = [];
  const telemetry = createTrackedPlaybackTelemetry(
    new Response(null, { headers: { "X-TTS-Attempt-ID": "attempt-pagehide" } }),
    true,
    {
      fetchImpl: async () => new Response(null, { status: 500 }),
      randomUUID: () => "event-pagehide",
      wait: async () => {},
    },
  );
  assert.ok(telemetry);
  await telemetry!.emit("play_failed");
  const cleanup = installPlaybackTelemetryFlushListeners(
    target,
    (url, body) => { beacons.push({ url, body }); return true; },
  );
  assert.deepEqual(Array.from(handlers.keys()).sort(), ["beforeunload", "pagehide"]);
  handlers.get("pagehide")?.();
  cleanup();
  assert.deepEqual(removed.sort(), ["beforeunload", "pagehide"]);
  assert.equal(handlers.size, 0);
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, "/api/playback-event");
  assert.equal(beacons[0].body.type, "application/json");
  const body = JSON.parse(await beacons[0].body.text()) as Record<string, unknown>;
  assert.deepEqual(body, {
    eventId: "event-pagehide",
    ttsAttemptId: "attempt-pagehide",
    eventType: "play_failed",
    clientElapsedMs: body.clientElapsedMs,
  });
  assert.equal(Number.isInteger(body.clientElapsedMs), true);
  assert.doesNotMatch(JSON.stringify(body), /audio|transcript|raw error/i);
});

it("caps page-lifecycle pending telemetry at 32 safe events", async () => {
  const eventTypes = [
    "audio_ready", "play_started", "play_completed", "play_failed",
  ] as const;
  let eventId = 0;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const telemetry = createTrackedPlaybackTelemetry(
      new Response(null, { headers: { "X-TTS-Attempt-ID": `attempt-bounded-${attempt}` } }),
      true,
      {
        fetchImpl: async () => new Response(null, { status: 500 }),
        randomUUID: () => `event-bounded-${++eventId}`,
        wait: async () => {},
      },
    );
    assert.ok(telemetry);
    await Promise.all(eventTypes.map((eventType) => telemetry!.emit(eventType)));
  }
  const bodies: Blob[] = [];
  assert.equal(flushPendingPlaybackEvents((_url, body) => {
    bodies.push(body);
    return true;
  }), 32);
  assert.equal(bodies.length, 32);
  for (const body of bodies) {
    assert.deepEqual(
      Object.keys(JSON.parse(await body.text()) as Record<string, unknown>).sort(),
      ["clientElapsedMs", "eventId", "eventType", "ttsAttemptId"],
    );
  }
});

it("does not retain terminal 4xx telemetry for unload retries", async () => {
  const telemetry = createTrackedPlaybackTelemetry(
    new Response(null, { headers: { "X-TTS-Attempt-ID": "attempt-terminal" } }),
    true,
    {
      fetchImpl: async () => new Response(null, { status: 403 }),
      randomUUID: () => "event-terminal",
    },
  );
  assert.ok(telemetry);
  assert.equal(await telemetry!.emit("play_started"), false);
  assert.equal(flushPendingPlaybackEvents(() => true), 0);
});
