"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import {
  MAX_REFERENCE_AUDIO_DURATION_SEC,
  MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC,
} from "@/lib/voiceLimits";
import type {
  VoiceAuthorization,
  VoiceAuthorizationBasis,
  VoiceSpeakerStatus,
} from "@/lib/storage/types";
import {
  buildVoiceAuthorizationPayload,
  createVoiceAuthorizationRequestGate,
  mapVoiceAuthorizationStatus,
  runLatestVoiceAuthorizationRequest,
} from "@/lib/voiceAuthorizationClient";

type VoiceMeta = {
  voiceId: string;
  promptText: string;
  createdAt: string;
  durationSec?: number | null;
};

type SelectedAudio = {
  file: File;
  durationSec?: number;
};

function readAudioDuration(file: File): Promise<number | undefined> {
  if (typeof window === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(undefined);
    };
    audio.src = url;
  });
}

export default function VoiceNewPage() {
  const [voices, setVoices] = useState<VoiceMeta[]>([]);
  const [audioFiles, setAudioFiles] = useState<SelectedAudio[]>([]);
  const [promptText, setPromptText] = useState("");
  const [uploading, setUploading] = useState(false);

  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [text, setText] = useState("你好，这是我的声音。");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const authorizationRequestGateRef = useRef(createVoiceAuthorizationRequestGate());
  const [audioUrl, setAudioUrl] = useState("");
  const prevAudioUrlRef = useRef<string>("");
  const [transcribing, setTranscribing] = useState(false);
  const [speakerStatus, setSpeakerStatus] = useState<VoiceSpeakerStatus>("living");
  const [authorizationBasis, setAuthorizationBasis] = useState<VoiceAuthorizationBasis>("self");
  const [separateConsentConfirmed, setSeparateConsentConfirmed] = useState(false);
  const [thirdPartyProcessingConfirmed, setThirdPartyProcessingConfirmed] = useState(false);
  const [syntheticDisclosureConfirmed, setSyntheticDisclosureConfirmed] = useState(false);
  const [authorization, setAuthorization] = useState<Pick<
    VoiceAuthorization,
    "status" | "reasonCode" | "speakerStatus" | "basis"
  > | null>(null);
  const [authorizationLoading, setAuthorizationLoading] = useState(false);
  const [authorizationVoiceId, setAuthorizationVoiceId] = useState("");
  const [presetState, setPresetState] = useState<{ status: string | null; errorCode: string | null }>({ status: null, errorCode: null });

  // 录音
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const recordTimeRef = useRef(0);
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
        setAudioFiles([{ file, durationSec: recordTimeRef.current || MAX_REFERENCE_AUDIO_DURATION_SEC }]);
        setPromptText("");
      };
      mr.start();
      setRecording(true);
      setRecordTime(0);
      recordTimeRef.current = 0;
      timerRef.current = setInterval(() => {
        setRecordTime((prev) => {
          if (prev >= MAX_REFERENCE_AUDIO_DURATION_SEC - 1) {
            recordTimeRef.current = MAX_REFERENCE_AUDIO_DURATION_SEC;
            stopRecording();
            return MAX_REFERENCE_AUDIO_DURATION_SEC;
          }
          const next = prev + 1;
          recordTimeRef.current = next;
          return next;
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
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      setVoices(j.voices || []);
      setSelectedVoiceId((prev) => prev || j.voices?.[0]?.voiceId || "");
    } catch {}
  }
  useEffect(() => { refreshVoices(); }, []);

  async function refreshAuthorization(voiceId: string) {
    if (!voiceId) {
      authorizationRequestGateRef.current.cancel();
      setAuthorization(null);
      setAuthorizationVoiceId("");
      setAuthorizationLoading(false);
      return;
    }
    setAuthorization(null);
    setPresetState({ status: null, errorCode: null });
    await runLatestVoiceAuthorizationRequest({
      gate: authorizationRequestGateRef.current,
      setLoading: setAuthorizationLoading,
      request: async () => {
        const response = await fetch(`/api/voice/authorization?voiceId=${encodeURIComponent(voiceId)}`);
        if (response.status === 404) return { authorization: null, missing: true };
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("授权状态读取失败");
        return { ...body, missing: false };
      },
      onSuccess: (body) => {
        setAuthorization(body.authorization || null);
        if (body.authorization) {
          setSpeakerStatus(body.authorization.speakerStatus);
          setAuthorizationBasis(body.authorization.basis);
        }
        setAuthorizationVoiceId(voiceId);
        setPresetState({
          status: body.missing ? null : body.presetStatus || null,
          errorCode: body.missing ? null : body.presetErrorCode || null,
        });
      },
      onError: () => {
        setError("授权状态读取失败，请稍后重试");
        setAuthorization(null);
        setAuthorizationVoiceId(voiceId);
      },
    });
  }

  useEffect(() => { void refreshAuthorization(selectedVoiceId); }, [selectedVoiceId]);

  async function handleAuthorizationSubmit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!selectedVoiceId) return setError("请先选择一段参考声音");
    const voiceId = selectedVoiceId;
    await runLatestVoiceAuthorizationRequest({
      gate: authorizationRequestGateRef.current,
      setLoading: setAuthorizationLoading,
      request: async () => {
        const response = await fetch("/api/voice/authorization", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildVoiceAuthorizationPayload({
            voiceId,
            speakerStatus,
            basis: authorizationBasis,
            separateConsentConfirmed,
            thirdPartyProcessingConfirmed,
            syntheticDisclosureConfirmed,
          })),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.reasonCode || body.error || "授权提交失败");
        return body;
      },
      onSuccess: (body) => {
        setAuthorization(body.authorization || null);
        if (body.authorization) {
          setSpeakerStatus(body.authorization.speakerStatus);
          setAuthorizationBasis(body.authorization.basis);
        }
        setAuthorizationVoiceId(voiceId);
        setPresetState({ status: body.presetStatus || null, errorCode: body.presetErrorCode || null });
        if (body.presetStatus === "failed") {
          setError(`授权已通过，但音色创建失败：${body.presetErrorCode || "preset_failed"}`);
        }
      },
      onError: (requestError) => {
        setError(requestError instanceof Error ? requestError.message : "授权提交失败");
      },
    });
  }

  async function handleAuthorizationRevoke() {
    if (!selectedVoiceId) return;
    const voiceId = selectedVoiceId;
    setError("");
    await runLatestVoiceAuthorizationRequest({
      gate: authorizationRequestGateRef.current,
      setLoading: setAuthorizationLoading,
      request: async () => {
        const response = await fetch(
          `/api/voice/authorization?voiceId=${encodeURIComponent(voiceId)}`,
          { method: "DELETE" },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "授权撤回失败");
        return body;
      },
      onSuccess: (body) => {
        if (authorization && authorizationVoiceId === voiceId) {
          setAuthorization({
            ...authorization,
            status: body.status === "rejected" ? "rejected" : "revoked",
            reasonCode: body.status === "rejected" ? authorization.reasonCode : null,
          });
        }
        setPresetState({
          status: body.cleanupPending ? "failed" : "not_created",
          errorCode: body.cleanupPending ? "cleanup_pending" : null,
        });
        if (body.cleanupPending) setError("授权已撤回，供应商音色仍在清理中");
      },
      onError: (requestError) => {
        setError(requestError instanceof Error ? requestError.message : "授权撤回失败");
      },
    });
  }

  async function handleTranscribe() {
    if (audioFiles.length !== 1) return setError("自动识别请先选择单个音频文件。多段素材上传时可留空，系统会逐段识别。");
    const audioFile = audioFiles[0].file;
    const isWebm = audioFile.type.includes("webm");
    if (isWebm) return setError("浏览器录音为 webm 格式，暂不支持自动识别。请手动在上方输入音频对应的文字。");
    setTranscribing(true); setError("");
    try {
      const fd = new FormData(); fd.append("audio", audioFile);
      const r = await fetch("/api/voice/transcribe", { method: "POST", body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "识别失败");
      setPromptText(j?.text || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setTranscribing(false); }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (audioFiles.length === 0) return setError("请选择参考音频文件");
    setUploading(true);
    try {
      const fd = new FormData();
      audioFiles.forEach(({ file, durationSec }) => {
        fd.append("audio", file);
        fd.append("durationSec", durationSec ? String(durationSec) : "");
      });
      if (promptText.trim()) fd.append("promptText", promptText.trim());
      const r = await fetch("/api/voice/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "上传失败");
      setAudioFiles([]); setPromptText("");
      await refreshVoices();
      setSelectedVoiceId(j.voice?.voiceId || j.voices?.[0]?.voiceId || "");
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
  const authorizationDisplay = mapVoiceAuthorizationStatus(authorization);
  const canContinue = authorizationVoiceId === selectedVoiceId
    && authorizationDisplay.canContinue
    && !authorizationLoading;
  const canSubmitAuthorization = !authorization
    || authorization.status === "revoked"
    || (authorization.status === "approved" && presetState.status === "failed");

  return (
    <AppShell>
    <main className="y-page">
      <div className="y-nav">
        <Link href="/" className="y-nav-back">← 首页</Link>
      </div>

      <h1 className="y-title">录一段参考声音</h1>
      <p className="y-subtitle">可以上传多段声音素材，素材库最多 5 分钟；单段请控制在 10 到 30 秒。</p>

      {/* Step 1: 录音/上传 */}
      <div className="y-card" style={{ marginTop: 24 }}>
        <div className="y-step">
          <span className="y-step-num">1</span>
          <span className="y-step-label">录下那个人的声音</span>
        </div>

        {recording ? (
          <div className="y-record-area recording">
            <span style={{ fontSize: 14, color: "var(--danger)", fontWeight: 500 }}>
              正在录音
            </span>
            <div className="y-record-timer">{formatTime(recordTime)}</div>
            <div className="y-record-wave">
              {waveHeights.map((h, i) => (
                <div key={i} className="y-record-wave-bar" style={{ height: h }} />
              ))}
            </div>
            <button type="button" onClick={stopRecording} className="y-btn y-btn-sm" style={{ background: "var(--danger)" }}>
              停止录音
            </button>
          </div>
        ) : audioFiles.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {audioFiles.map(({ file, durationSec }, index) => (
              <div key={`${file.name}-${index}`} className="y-file-card">
                <span className="y-file-type">音频</span>
                <div className="y-file-info">
                  <div className="y-file-name">{file.name}</div>
                  <div className="y-file-meta">
                    {(file.size / 1024).toFixed(0)} KB
                    {durationSec ? ` · ${formatTime(Math.round(durationSec))}` : ""}
                    {" · 已就绪"}
                  </div>
                </div>
                <button
                  onClick={() => setAudioFiles((prev) => prev.filter((_, i) => i !== index))}
                  className="y-btn-ghost y-btn-sm"
                >
                  移除
                </button>
              </div>
            ))}
            <div style={{ color: "var(--text-hint)", fontSize: 12, lineHeight: 1.7 }}>
              已选择 {audioFiles.length} 段素材。单段最长 {MAX_REFERENCE_AUDIO_DURATION_SEC} 秒，素材库最多 {Math.floor(MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC / 60)} 分钟。
            </div>
          </div>
        ) : (
          <div className="y-record-area" onClick={startRecording} style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 12, display: "block", marginBottom: 10, color: "var(--text-accent)", letterSpacing: "0.18em", textTransform: "uppercase" }}>record</span>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, margin: 0 }}>
              点击此处开始录音
            </p>
            <p style={{ color: "var(--text-hint)", fontSize: 12, marginTop: 4 }}>
              每段最长 {MAX_REFERENCE_AUDIO_DURATION_SEC} 秒，也可从下方选择多个文件
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
              <input
                type="file"
                accept="audio/*"
                multiple
                onChange={async (e) => {
                  const selected = Array.from(e.target.files || []);
                  const withDuration = await Promise.all(
                    selected.map(async (file) => ({ file, durationSec: await readAudioDuration(file) })),
                  );
                  setAudioFiles(withDuration);
                  setPromptText("");
                }}
                style={{ display: "none" }} />
              选择音频文件
            </label>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span className="y-label" style={{ marginBottom: 0 }}>音频里说了什么</span>
              <button type="button" onClick={handleTranscribe} disabled={audioFiles.length !== 1 || transcribing}
                className="y-btn-text" style={{ fontSize: 12 }}>
                {transcribing ? "识别中…" : "自动识别"}
              </button>
            </div>
            <textarea value={promptText} onChange={(e) => setPromptText(e.target.value)} rows={3}
              placeholder="点击右上角「自动识别」，或手动输入音频对应的文字"
              className="y-textarea" />
            <p style={{ color: "var(--text-hint)", fontSize: 11, marginTop: 4 }}>
              多段素材最多累计 {Math.floor(MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC / 60)} 分钟。mp3/wav/m4a 可自动识别；录音（webm）请手动输入文字稿。
            </p>

            <button type="button" onClick={handleUpload} disabled={uploading || audioFiles.length === 0}
              className="y-btn" style={{ marginTop: 12, width: "100%" }}>
              {uploading ? "上传中…" : "上传保存"}
            </button>
          </>
        )}
      </div>

      <div className="y-card">
        <div className="y-step">
          <span className="y-step-num">2</span>
          <span className="y-step-label">确认声音授权</span>
        </div>
        {voices.length === 0 ? (
          <p style={{ color: "var(--text-hint)", fontSize: 13 }}>先上传一段声音，再提交这一段声音的授权。</p>
        ) : (
          <form onSubmit={handleAuthorizationSubmit}>
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
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              当前声音：{authorizationLoading ? "读取中…" : authorizationDisplay.label}
              {authorizationDisplay.errorCode ? ` · ${authorizationDisplay.errorCode}` : ""}
              {presetState.status === "failed" ? ` · 音色创建失败：${presetState.errorCode || "preset_failed"}` : ""}
            </p>
            <label className="y-label" style={{ marginTop: 12 }}>
              声音主人是否健在
              <select value={speakerStatus} onChange={(e) => {
                const next = e.target.value as VoiceSpeakerStatus;
                setSpeakerStatus(next);
                setAuthorizationBasis(next === "living" ? "self" : "close_relative_request");
              }} disabled={Boolean(authorization)} className="y-select" style={{ marginTop: 6 }}>
                <option value="living">健在</option>
                <option value="deceased">已故</option>
              </select>
            </label>
            <label className="y-label" style={{ marginTop: 12 }}>
              授权依据
              <select value={authorizationBasis} onChange={(e) => setAuthorizationBasis(e.target.value as VoiceAuthorizationBasis)} disabled={Boolean(authorization)} className="y-select" style={{ marginTop: 6 }}>
                {speakerStatus === "living" ? <>
                  <option value="self">这是我本人的声音</option>
                  <option value="speaker_separate_consent">声音主人已单独同意</option>
                  <option value="legal_representative">我是合法代理人</option>
                </> : <>
                  <option value="close_relative_request">我是近亲属并提出申请</option>
                  <option value="legal_representative">我有合法代理依据</option>
                </>}
              </select>
            </label>
            {[
              [separateConsentConfirmed, setSeparateConsentConfirmed, "我确认有权提交并处理这段声音"],
              [thirdPartyProcessingConfirmed, setThirdPartyProcessingConfirmed, "我同意将声音交给第三方服务生成合成语音"],
              [syntheticDisclosureConfirmed, setSyntheticDisclosureConfirmed, "我知道系统输出是 AI 合成语音，不代表声音主人的真实意志"],
            ].map(([checked, setter, label]) => (
              <label key={String(label)} style={{ display: "flex", gap: 8, marginTop: 12, color: "var(--text-secondary)", fontSize: 13 }}>
                <input type="checkbox" checked={checked as boolean} onChange={(e) => (setter as (value: boolean) => void)(e.target.checked)} />
                <span>{String(label)}</span>
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button type="submit" disabled={authorizationLoading || !canSubmitAuthorization} className="y-btn">
                {authorizationLoading ? "处理中…" : authorization?.status === "revoked" ? "重新提交授权" : presetState.status === "failed" ? "重试创建音色" : "提交授权"}
              </button>
              {authorization && (
                authorization.status === "approved"
                || authorization.status === "pending_review"
                || (authorization.status === "rejected" && presetState.status === "failed")
              ) && (
                <button type="button" onClick={handleAuthorizationRevoke} disabled={authorizationLoading} className="y-btn-ghost">
                  {authorization.status === "rejected" ? "重试清理音色" : "撤回授权"}
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {/* Step 3: 试听 */}
      <div className="y-card">
        <div className="y-step">
          <span className="y-step-num">3</span>
          <span className="y-step-label">试听克隆效果</span>
        </div>
        {voices.length === 0 ? (
          <div className="y-empty-warm" style={{ padding: "var(--sp-lg) 0" }}>
            <p style={{ color: "var(--text-hint)", fontSize: 13, margin: 0 }}>上传音频后在这里试听</p>
          </div>
        ) : (
          <form onSubmit={handleTest}>
            <label className="y-label">
              试听文本
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
                className="y-textarea" style={{ marginTop: 6 }} />
            </label>
            <button type="submit" disabled={generating || !canContinue} className="y-btn" style={{ marginTop: 12 }}>
              {generating ? "生成中…" : canContinue ? "试听" : "授权通过后可试听"}
            </button>
            {audioUrl && (
              <audio ref={audioRef} src={audioUrl} controls style={{ marginTop: 12, width: "100%" }} />
            )}
          </form>
        )}
      </div>

      <div style={{ textAlign: "center", marginTop: 8 }}>
        {canContinue ? (
          <Link href="/persona/new" className="y-btn-ghost" style={{ fontSize: 13 }}>
            授权通过，去创建人物 →
          </Link>
        ) : (
          <span style={{ color: "var(--text-hint)", fontSize: 13 }}>授权通过后才能创建可对话人物</span>
        )}
      </div>

      {error && <div className="y-error">{error}</div>}
    </main>
    </AppShell>
  );
}
