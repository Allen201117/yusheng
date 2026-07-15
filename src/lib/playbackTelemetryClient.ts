import type { PlaybackEventType } from "./storage/types";

const MAX_ID_LENGTH = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_CLIENT_ELAPSED_MS = 300_000;
const MAX_SEND_ATTEMPTS = 2;
const MAX_PENDING_EVENTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

type PlaybackEventBody = {
  eventId: string;
  ttsAttemptId: string;
  eventType: PlaybackEventType;
  clientElapsedMs: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, milliseconds: number) => TimerHandle;
type ClearTimeoutFn = (timer: TimerHandle) => void;

type TelemetryDependencies = {
  fetchImpl: typeof fetch;
  randomUUID: () => string;
  nowMs: () => number;
  wait: (milliseconds: number) => Promise<void>;
  requestTimeoutMs: number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
};

const pendingEvents = new Map<string, PlaybackEventBody>();

export type PlaybackOutcome = "completed" | "cancelled";

export type PlaybackCancellationSlot = {
  current: { token: symbol; cancel: () => void } | null;
};

export type PlaybackTelemetry = {
  emit(eventType: PlaybackEventType): Promise<boolean>;
  whenSettled(): Promise<void>;
};

export type TelemetryAudioElement = {
  onloadeddata: ((...args: any[]) => unknown) | null;
  onended: ((...args: any[]) => unknown) | null;
  onerror: ((...args: any[]) => unknown) | null;
  play(): Promise<void>;
};

type FlushEventTarget = {
  addEventListener(type: "pagehide" | "beforeunload", listener: () => void): void;
  removeEventListener(type: "pagehide" | "beforeunload", listener: () => void): void;
};

type SendBeacon = (url: string, data: Blob) => boolean;

function rememberPending(body: PlaybackEventBody): void {
  if (!pendingEvents.has(body.eventId) && pendingEvents.size >= MAX_PENDING_EVENTS) {
    const oldest = pendingEvents.keys().next().value as string | undefined;
    if (oldest) pendingEvents.delete(oldest);
  }
  pendingEvents.set(body.eventId, body);
}

function forgetPending(body: PlaybackEventBody): void {
  if (pendingEvents.get(body.eventId) === body) pendingEvents.delete(body.eventId);
}

export function flushPendingPlaybackEvents(sendBeacon?: SendBeacon): number {
  const sender = sendBeacon ?? ((url: string, data: Blob) =>
    globalThis.navigator.sendBeacon(url, data));
  let queued = 0;
  for (const [eventId, body] of pendingEvents) {
    try {
      const data = new Blob([JSON.stringify(body)], { type: "application/json" });
      if (sender("/api/playback-event", data)) {
        pendingEvents.delete(eventId);
        queued += 1;
      }
    } catch {
      // Keep the bounded event for the next lifecycle flush attempt.
    }
  }
  return queued;
}

export function installPlaybackTelemetryFlushListeners(
  target: FlushEventTarget = globalThis.window,
  sendBeacon?: SendBeacon,
): () => void {
  const flush = () => { flushPendingPlaybackEvents(sendBeacon); };
  target.addEventListener("pagehide", flush);
  target.addEventListener("beforeunload", flush);
  return () => {
    flush();
    target.removeEventListener("pagehide", flush);
    target.removeEventListener("beforeunload", flush);
  };
}

function emitWithoutBlocking(
  telemetry: PlaybackTelemetry | null,
  eventType: PlaybackEventType,
): void {
  try {
    void telemetry?.emit(eventType);
  } catch {
    // Reporting must never change or interrupt real playback.
  }
}

function validAttemptId(value: string | null): value is string {
  return value !== null
    && value.length >= 1
    && value.length <= MAX_ID_LENGTH
    && value === value.trim()
    && !CONTROL_CHARACTERS.test(value);
}

function elapsedMs(now: number, startedAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(startedAt)) return 0;
  return Math.min(MAX_CLIENT_ELAPSED_MS, Math.max(0, Math.round(now - startedAt)));
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createTrackedPlaybackTelemetry(
  response: Pick<Response, "headers">,
  tracked: boolean,
  overrides: Partial<TelemetryDependencies> = {},
): PlaybackTelemetry | null {
  if (!tracked) return null;
  const ttsAttemptId = response.headers.get("X-TTS-Attempt-ID");
  if (!validAttemptId(ttsAttemptId)) return null;
  const stableAttemptId = ttsAttemptId;

  const dependencies: TelemetryDependencies = {
    fetchImpl: globalThis.fetch.bind(globalThis),
    randomUUID: () => globalThis.crypto.randomUUID(),
    nowMs: () => performance.now(),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    setTimeoutFn: globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn: globalThis.clearTimeout.bind(globalThis),
    ...overrides,
  };
  const startedAt = dependencies.nowMs();
  const events = new Map<PlaybackEventType, Promise<boolean>>();

  function emit(eventType: PlaybackEventType): Promise<boolean> {
    const existing = events.get(eventType);
    if (existing) return existing;

    const body: PlaybackEventBody = {
      eventId: dependencies.randomUUID(),
      ttsAttemptId: stableAttemptId,
      eventType,
      clientElapsedMs: elapsedMs(dependencies.nowMs(), startedAt),
    };
    rememberPending(body);
    const sending = (async () => {
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = dependencies.setTimeoutFn(
          () => controller.abort(),
          dependencies.requestTimeoutMs,
        );
        try {
          const result = await dependencies.fetchImpl("/api/playback-event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: true,
            signal: controller.signal,
          });
          if (result.ok) {
            forgetPending(body);
            return true;
          }
          if (!shouldRetry(result.status)) {
            forgetPending(body);
            return false;
          }
        } catch {
          // Playback remains authoritative; telemetry failure never interrupts it.
        } finally {
          dependencies.clearTimeoutFn(timeout);
        }
        if (attempt < MAX_SEND_ATTEMPTS) await dependencies.wait(100);
      }
      return false;
    })();
    events.set(eventType, sending);
    return sending;
  }

  return {
    emit,
    async whenSettled() {
      await Promise.allSettled(Array.from(events.values()));
    },
  };
}

export async function playAudioWithTelemetry(
  audio: TelemetryAudioElement,
  telemetry: PlaybackTelemetry | null,
  onPlaybackStarted: () => void,
  prepareAudio: (cancelPlayback: () => void) => void = () => {},
): Promise<PlaybackOutcome> {
  return new Promise<PlaybackOutcome>((resolve, reject) => {
    let settled = false;
    const reportFailure = () => {
      if (settled) return false;
      settled = true;
      emitWithoutBlocking(telemetry, "play_failed");
      return true;
    };
    audio.onloadeddata = () => {
      if (!settled) emitWithoutBlocking(telemetry, "audio_ready");
    };
    audio.onended = () => {
      if (settled) return;
      settled = true;
      emitWithoutBlocking(telemetry, "play_completed");
      resolve("completed");
    };
    audio.onerror = () => {
      if (reportFailure()) reject(new Error("音频播放失败"));
    };

    prepareAudio(() => {
      if (settled) return;
      settled = true;
      resolve("cancelled");
    });
    audio.play().then(
      () => {
        if (settled) return;
        emitWithoutBlocking(telemetry, "play_started");
        try { onPlaybackStarted(); } catch {}
      },
      (error: unknown) => {
        if (reportFailure()) reject(error);
      },
    );
  });
}

export function cancelPlaybackLifecycle(slot: PlaybackCancellationSlot): void {
  slot.current?.cancel();
}

export async function playAudioItemLifecycle(input: {
  audio: TelemetryAudioElement;
  telemetry: PlaybackTelemetry | null;
  onPlaybackStarted: () => void;
  prepareAudio: () => void;
  pauseAfterMs: number;
  cancellationSlot: PlaybackCancellationSlot;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}): Promise<PlaybackOutcome> {
  const token = Symbol("playback-item");
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  try {
    const playback = await playAudioWithTelemetry(
      input.audio,
      input.telemetry,
      input.onPlaybackStarted,
      (cancel) => {
        input.cancellationSlot.current = { token, cancel };
        input.prepareAudio();
      },
    );
    if (playback === "cancelled" || input.pauseAfterMs <= 0) return playback;

    return await new Promise<PlaybackOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        resolve("completed");
      }, input.pauseAfterMs);
      input.cancellationSlot.current = {
        token,
        cancel: () => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          resolve("cancelled");
        },
      };
    });
  } finally {
    if (input.cancellationSlot.current?.token === token) {
      input.cancellationSlot.current = null;
    }
  }
}
