import type { PlaybackEventType } from "./storage/types";

const MAX_ID_LENGTH = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_CLIENT_ELAPSED_MS = 300_000;
const MAX_SEND_ATTEMPTS = 2;

type PlaybackEventBody = {
  eventId: string;
  ttsAttemptId: string;
  eventType: PlaybackEventType;
  clientElapsedMs: number;
};

type TelemetryDependencies = {
  fetchImpl: typeof fetch;
  randomUUID: () => string;
  nowMs: () => number;
  wait: (milliseconds: number) => Promise<void>;
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
    const sending = (async () => {
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        try {
          const result = await dependencies.fetchImpl("/api/playback-event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (result.ok) return true;
          if (!shouldRetry(result.status)) return false;
        } catch {
          // Playback remains authoritative; telemetry failure never interrupts it.
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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
      resolve();
    };
    audio.onerror = () => {
      if (reportFailure()) reject(new Error("音频播放失败"));
    };

    prepareAudio(() => {
      if (settled) return;
      settled = true;
      resolve();
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
