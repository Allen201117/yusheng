"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { use } from "react";
import AppShell from "@/components/AppShell";
import { OrderedPlaybackQueue } from "@/lib/orderedPlaybackQueue";
import {
  buildTrackedTtsRequest,
  trackedSpeechFromSseEvent,
} from "@/lib/chatSpeechClient";
import type { SpeechPlan, TrackedSpeechPlan } from "@/lib/speechPlanning";

type Msg = { id: string; role: "user" | "assistant"; content: string; createdAt: string };
type RetrievedMemory = { content: string; score: number };
type PreparedSpeech = { blob: Blob; plan: SpeechPlan; requestedAt: number; serverMs: string | null };

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: personaId } = use(params);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const [lastRetrieved, setLastRetrieved] = useState<RetrievedMemory[]>([]);
  const [streaming, setStreaming] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const blobUrlRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const ttsControllersRef = useRef(new Set<AbortController>());
  const playbackQueueRef = useRef<OrderedPlaybackQueue<PreparedSpeech> | null>(null);
  const pendingSpeechRef = useRef(0);
  const playbackDoneRef = useRef<(() => void) | null>(null);
  const turnStartedAtRef = useRef(0);
  const firstAudioReportedRef = useRef(false);

  async function loadHistory() {
    try {
      const r = await fetch(`/api/chat?personaId=${personaId}`);
      setMessages((await r.json()).messages || []);
    } catch {}
  }
  useEffect(() => { loadHistory(); }, [personaId]);

  useEffect(() => () => stopSpeech(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function finishSpeechItem() {
    pendingSpeechRef.current = Math.max(0, pendingSpeechRef.current - 1);
    if (pendingSpeechRef.current === 0) setSpeaking(false);
  }

  async function playPreparedSpeech(prepared: PreparedSpeech) {
    try {
      const audio = audioRef.current;
      if (!audio) throw new Error("播放器不可用");
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = URL.createObjectURL(prepared.blob);
      audio.src = blobUrlRef.current;
      await new Promise<void>((resolve, reject) => {
        playbackDoneRef.current = resolve;
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("音频播放失败"));
        audio.play().then(() => {
          if (!firstAudioReportedRef.current && turnStartedAtRef.current > 0) {
            firstAudioReportedRef.current = true;
            console.info(JSON.stringify({
              event: "first_audio_playback",
              firstAudioMs: Math.round(performance.now() - turnStartedAtRef.current),
              ttsRequestMs: Math.round(performance.now() - prepared.requestedAt),
              serverMs: prepared.serverMs,
            }));
          }
        }).catch(reject);
      });
      if (prepared.plan.pauseAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, prepared.plan.pauseAfterMs));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      playbackDoneRef.current = null;
      finishSpeechItem();
    }
  }

  function getPlaybackQueue() {
    if (!playbackQueueRef.current) {
      playbackQueueRef.current = new OrderedPlaybackQueue<PreparedSpeech>(
        playPreparedSpeech,
        (err) => {
          finishSpeechItem();
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setError(err instanceof Error ? err.message : String(err));
          }
        },
      );
    }
    return playbackQueueRef.current;
  }

  function stopSpeech() {
    for (const controller of ttsControllersRef.current) controller.abort();
    ttsControllersRef.current.clear();
    playbackQueueRef.current?.reset();
    pendingSpeechRef.current = 0;
    playbackDoneRef.current?.();
    playbackDoneRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = "";
    setSpeaking(false);
  }

  async function requestSpeech(plan: SpeechPlan | TrackedSpeechPlan): Promise<PreparedSpeech> {
    const controller = new AbortController();
    ttsControllersRef.current.add(controller);
    const requestedAt = performance.now();
    try {
      const r = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify("sentenceId" in plan
          ? buildTrackedTtsRequest(plan)
          : { personaId, text: plan.text, speech: plan }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({})))).error || `TTS 失败`);
      return { blob: await r.blob(), plan, requestedAt, serverMs: r.headers.get("X-TTS-Ms") };
    } finally {
      ttsControllersRef.current.delete(controller);
    }
  }

  function enqueueSpeech(plan: SpeechPlan | TrackedSpeechPlan) {
    pendingSpeechRef.current += 1;
    setSpeaking(true);
    getPlaybackQueue().enqueue(requestSpeech(plan));
  }

  function speak(replyText: string) {
    stopSpeech();
    turnStartedAtRef.current = performance.now();
    firstAudioReportedRef.current = false;
    enqueueSpeech({
      index: 0,
      text: replyText,
      emotion: "calm",
      intensity: 45,
      speed: 1,
      pauseAfterMs: 0,
    });
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault(); setError("");
    const t = text.trim(); if (!t) return;
    stopSpeech();
    turnStartedAtRef.current = performance.now();
    firstAudioReportedRef.current = false;
    setSending(true); setStreaming(true); setText("");

    const aiMsgId = `ai-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", content: t, createdAt: new Date().toISOString() },
      { id: aiMsgId, role: "assistant", content: "", createdAt: new Date().toISOString() },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;
    let fullReply = "";
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId, text: t }),
        signal: abort.signal,
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({})))).error || "发送失败");

      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const json = JSON.parse(line.slice(6));
            if (json.meta) setLastRetrieved(json.meta.retrievedMemories || []);
            else if (json.token) {
              fullReply += json.token;
              setMessages((prev) => prev.map((m) => m.id === aiMsgId ? { ...m, content: fullReply } : m));
            } else if (json.sentence) {
              const plan = trackedSpeechFromSseEvent(json);
              if (!plan) throw new Error("语音追踪数据无效");
              enqueueSpeech(plan);
            } else if (json.done) {
              await loadHistory();
            } else if (json.error) throw new Error(json.error);
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err;
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false); setStreaming(false); abortRef.current = null;
    }
  }

  return (
    <AppShell>
    <main className="y-page y-chat-page" style={{ paddingBottom: 120 }}>
      <div className="y-nav">
        <Link href="/" className="y-nav-back">← 首页</Link>
        <div className="y-nav-actions">
          <Link href={`/persona/${personaId}/memories`} className="y-btn-ghost y-btn-sm">记忆</Link>
        </div>
      </div>

      <div className="y-chat-area y-chat-canvas">
        {messages.length === 0 ? (
          <div className="y-empty-warm">
            <h2 className="y-empty-title">开始第一句话吧</h2>
            <p className="y-empty-desc">
              像他还在的时候那样说话就好。
              <br />
              不必刻意，不必煽情。
            </p>
          </div>
        ) : (
          messages.map((m, idx) => {
            const isLast = idx === messages.length - 1;
            const isStreamingAi = m.role === "assistant" && streaming && isLast;
            const isSpeakingAi = m.role === "assistant" && speaking && isLast;
            return (
              <div key={m.id} className={`y-bubble-row ${m.role}`}>
                <div className={`y-bubble ${m.role}`} style={{
                  animation: m.id.startsWith("u-") || m.id.startsWith("ai-")
                    ? "bubbleIn 0.25s var(--ease-out)" : "none",
                }}>
                  {(isStreamingAi || isSpeakingAi) && (
                    <span className="y-speaking-indicator">
                      <span /><span /><span />
                    </span>
                  )}
                  {m.content || (isStreamingAi ? "" : "")}
                  {m.role === "assistant" && m.content && !isStreamingAi && (
                    <span className="y-bubble-actions">
                      <button onClick={() => speak(m.content)} disabled={speaking}
                        className="y-btn-ghost y-btn-sm">
                        {speaking && isSpeakingAi ? "播放中" : "重放"}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* 底部输入 */}
      <div className="y-chat-dock">
        <form onSubmit={handleSend} className="y-chat-bar">
          <input
            value={streaming ? "" : text}
            onChange={(e) => setText(e.target.value)}
            placeholder={streaming ? "对方正在输入…" : "说点什么…"}
            className="y-input" disabled={sending}
          />
          {streaming ? (
            <button type="button" onClick={() => { abortRef.current?.abort(); stopSpeech(); }} className="y-btn-ghost">停止</button>
          ) : (
            <button type="submit" disabled={sending} className="y-btn">{sending ? "…" : "发送"}</button>
          )}
        </form>
      </div>

      <audio ref={audioRef} style={{ display: "none" }} />

      {lastRetrieved.length > 0 && (
        <details className="y-retrieval" style={{ marginTop: 12 }}>
          <summary>记忆召回（{lastRetrieved.length} 条）</summary>
          <ul>{lastRetrieved.map((m, i) => <li key={i}><span className="score">[{m.score.toFixed(2)}]</span> {m.content}</li>)}</ul>
        </details>
      )}

      {error && <div className="y-error">{error}</div>}
    </main>
    </AppShell>
  );
}
