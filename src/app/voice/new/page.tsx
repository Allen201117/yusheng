"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";

type VoiceMeta = {
  voiceId: string;
  promptText: string;
  createdAt: string;
};

export default function VoiceNewPage() {
  const [voices, setVoices] = useState<VoiceMeta[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [promptText, setPromptText] = useState("");
  const [uploading, setUploading] = useState(false);

  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [text, setText] = useState("你好，这是我的声音。");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const prevAudioUrlRef = useRef<string>("");
  const [transcribing, setTranscribing] = useState(false);

  // 录音
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [waveHeights, setWaveHeights] = useState<number[]>([8, 14, 10, 20, 12, 16, 9, 18, 11, 15, 8, 13]);

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (waveRef.current) { clearInterval(waveRef.current); waveRef.current = null; }
  }

  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus" : "audio/webm",
      });
      mediaRecorderRef.current = mr;
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunks, { type: mr.mimeType });
        const file = new File([blob], `recording-${Date.now()}.webm`, { type: mr.mimeType });
        setAudioFile(file);
        setPromptText("");
      };
      mr.start();
      setRecording(true);
      setRecordTime(0);
      timerRef.current = setInterval(() => {
        setRecordTime((prev) => {
          if (prev >= 299) { stopRecording(); return 300; }
          return prev + 1;
        });
      }, 1000);
      // 波形动画
      waveRef.current = setInterval(() => {
        setWaveHeights(Array.from({ length: 12 }, () => 4 + Math.random() * 24));
      }, 100);
    } catch {
      setError("无法访问麦克风，请检查浏览器权限设置。");
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (waveRef.current) clearInterval(waveRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (prevAudioUrlRef.current) URL.revokeObjectURL(prevAudioUrlRef.current);
    prevAudioUrlRef.current = audioUrl;
    return () => { if (prevAudioUrlRef.current) URL.revokeObjectURL(prevAudioUrlRef.current); };
  }, [audioUrl]);

  async function refreshVoices() {
    try {
      const r = await fetch("/api/voice/upload");
      const j = await r.json();
      setVoices(j.voices || []);
      setSelectedVoiceId((prev) => prev || j.voices?.[0]?.voiceId || "");
    } catch {}
  }
  useEffect(() => { refreshVoices(); }, []);

  async function handleTranscribe() {
    if (!audioFile) return setError("请先选择音频文件");
    const isWebm = audioFile.type.includes("webm");
    if (isWebm) return setError("浏览器录音为 webm 格式，暂不支持自动识别。请手动在上方输入音频对应的文字。");
    setTranscribing(true); setError("");
    try {
      const fd = new FormData(); fd.append("audio", audioFile);
      const r = await fetch("/api/voice/transcribe", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "识别失败");
      setPromptText(j.text || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setTranscribing(false); }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!audioFile) return setError("请选择参考音频文件");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("audio", audioFile);
      fd.append("promptText", promptText.trim());
      const r = await fetch("/api/voice/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "上传失败");
      setAudioFile(null); setPromptText("");
      await refreshVoices();
      setSelectedVoiceId(j.voice.voiceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setUploading(false); }
  }

  async function handleTest(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!selectedVoiceId) return setError("请先上传或选择一段参考音频");
    setGenerating(true);
    try {
      const r = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId: selectedVoiceId, text }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `TTS 失败 ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      const audio = audioRef.current;
      if (audio) {
        audio.onloadeddata = () => audio.play().catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setGenerating(false); }
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <AppShell>
    <main className="y-page">
      <div className="y-nav">
        <Link href="/" className="y-nav-back">← 首页</Link>
      </div>

      <h1 className="y-title">录一段参考声音</h1>
      <p className="y-subtitle">5 分钟以内的清晰人声。越长，克隆出的音色和语调越像。</p>

      {/* Step 1: 录音/上传 */}
      <div className="y-card" style={{ marginTop: 24 }}>
        <div className="y-step">
          <span className="y-step-num">1</span>
          <span className="y-step-label">录下那个人的声音</span>
        </div>

        {recording ? (
          <div className="y-record-area recording">
            <span style={{ fontSize: 14, color: "var(--danger)", fontWeight: 500 }}>
              🔴 正在录音
            </span>
            <div className="y-record-timer">{formatTime(recordTime)}</div>
            <div className="y-record-wave">
              {waveHeights.map((h, i) => (
                <div key={i} className="y-record-wave-bar" style={{ height: h }} />
              ))}
            </div>
            <button type="button" onClick={stopRecording} className="y-btn y-btn-sm" style={{ background: "var(--danger)" }}>
              ⏹ 停止录音
            </button>
          </div>
        ) : audioFile ? (
          <div className="y-file-card" style={{ marginBottom: 16 }}>
            <span className="y-file-emoji">🎵</span>
            <div className="y-file-info">
              <div className="y-file-name">{audioFile.name}</div>
              <div className="y-file-meta">{(audioFile.size / 1024).toFixed(0)} KB · 已就绪</div>
            </div>
            <button onClick={() => setAudioFile(null)} className="y-btn-ghost y-btn-sm">移除</button>
          </div>
        ) : (
          <div className="y-record-area" onClick={startRecording} style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 40, display: "block", marginBottom: 8 }}>🎙️</span>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, margin: 0 }}>
              点击此处开始录音
            </p>
            <p style={{ color: "var(--text-hint)", fontSize: 12, marginTop: 4 }}>
              或从下方选择文件
            </p>
          </div>
        )}

        {!recording && (
          <>
            <label style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "10px 14px", background: "var(--bg-input)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)", cursor: "pointer", fontSize: 13,
              color: "var(--text-secondary)", marginBottom: 16,
            }}>
              <input type="file" accept="audio/*" onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                style={{ display: "none" }} />
              📁 选择音频文件
            </label>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span className="y-label" style={{ marginBottom: 0 }}>音频里说了什么</span>
              <button type="button" onClick={handleTranscribe} disabled={!audioFile || transcribing}
                className="y-btn-text" style={{ fontSize: 12 }}>
                {transcribing ? "识别中…" : "🤖 自动识别"}
              </button>
            </div>
            <textarea value={promptText} onChange={(e) => setPromptText(e.target.value)} rows={3}
              placeholder="点击右上角「自动识别」，或手动输入音频对应的文字"
              className="y-textarea" />
            <p style={{ color: "var(--text-hint)", fontSize: 11, marginTop: 4 }}>
              mp3/wav/m4a 可自动识别，录音（webm）请手动输入。识别后建议核对错别字。
            </p>

            <button type="button" onClick={handleUpload} disabled={uploading || !audioFile}
              className="y-btn" style={{ marginTop: 12, width: "100%" }}>
              {uploading ? "上传中…" : "⬆️ 上传保存"}
            </button>
          </>
        )}
      </div>

      {/* Step 2: 试听 */}
      <div className="y-card">
        <div className="y-step">
          <span className="y-step-num">2</span>
          <span className="y-step-label">试听克隆效果</span>
        </div>
        {voices.length === 0 ? (
          <div className="y-empty-warm" style={{ padding: "var(--sp-lg) 0" }}>
            <span className="y-empty-emoji" style={{ fontSize: 32 }}>🎧</span>
            <p style={{ color: "var(--text-hint)", fontSize: 13, margin: 0 }}>上传音频后在这里试听</p>
          </div>
        ) : (
          <form onSubmit={handleTest}>
            <label className="y-label">
              选择录音
              <select value={selectedVoiceId} onChange={(e) => setSelectedVoiceId(e.target.value)}
                className="y-select" style={{ marginTop: 6 }}>
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.createdAt.slice(0, 19).replace("T", " ")} · {v.promptText.slice(0, 25)}
                  </option>
                ))}
              </select>
            </label>
            <label className="y-label" style={{ marginTop: 16 }}>
              试听文本
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
                className="y-textarea" style={{ marginTop: 6 }} />
            </label>
            <button type="submit" disabled={generating} className="y-btn" style={{ marginTop: 12 }}>
              {generating ? "生成中…" : "▶️ 试听"}
            </button>
            {audioUrl && (
              <audio ref={audioRef} src={audioUrl} controls style={{ marginTop: 12, width: "100%" }} />
            )}
          </form>
        )}
      </div>

      <div style={{ textAlign: "center", marginTop: 8 }}>
        <Link href="/persona/new" className="y-btn-ghost" style={{ fontSize: 13 }}>
          上传好了，去创建人物 →
        </Link>
      </div>

      {error && <div className="y-error">{error}</div>}
    </main>
    </AppShell>
  );
}
