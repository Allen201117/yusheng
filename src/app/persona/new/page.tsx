"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";

type VoiceMeta = { voiceId: string; promptText: string; createdAt: string };

export default function PersonaNewPage() {
  const router = useRouter();
  const [voices, setVoices] = useState<VoiceMeta[]>([]);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [personaDesc, setPersonaDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/voice/upload")
      .then((r) => r.json())
      .then((j) => {
        setVoices(j.voices || []);
        if (j.voices?.[0]?.voiceId) setVoiceId(j.voices[0].voiceId);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!name.trim() || !relation.trim() || !voiceId) {
      setError("姓名、关系、参考声音都必须填"); return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/persona", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), relation: relation.trim(), voiceId, personaDesc: personaDesc.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "创建失败");
      router.push(`/persona/${j.persona.id}/memories`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSubmitting(false); }
  }

  const step = voices.length === 0 ? 0 : 1;

  return (
    <AppShell>
    <main className="y-page">
      <div className="y-nav">
        <Link href="/" className="y-nav-back">← 首页</Link>
      </div>

      <h1 className="y-title">创建一个人物</h1>
      <p className="y-subtitle">绑定参考声音和性格，让他更像他。</p>

      {step === 0 ? (
        <div className="y-empty-warm" style={{ marginTop: 32 }}>
          <h2 className="y-empty-title">还没有参考声音</h2>
          <p className="y-empty-desc">创建人物前需要先录一段那个人的声音。</p>
          <Link href="/voice/new" className="y-btn">去录声音</Link>
        </div>
      ) : (
        <div className="y-card" style={{ marginTop: 24 }}>
          <form onSubmit={handleSubmit}>
            <label className="y-label">
              姓名 / 称呼
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="例：爸爸 / 小明" className="y-input" style={{ marginTop: 6 }} />
            </label>

            <label className="y-label" style={{ marginTop: 16 }}>
              关系
              <input value={relation} onChange={(e) => setRelation(e.target.value)}
                placeholder="例：父亲 / 朋友 / 外婆" className="y-input" style={{ marginTop: 6 }} />
            </label>

            <label className="y-label" style={{ marginTop: 16 }}>
              参考声音
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}
                className="y-select" style={{ marginTop: 6 }}>
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.createdAt.slice(0, 19).replace("T", " ")} · {v.promptText.slice(0, 25)}
                  </option>
                ))}
              </select>
            </label>

            <label className="y-label" style={{ marginTop: 16 }}>
              性格 / 说话方式（强烈建议填写）
              <textarea value={personaDesc} onChange={(e) => setPersonaDesc(e.target.value)} rows={4}
                placeholder={"例：性格内敛但温和，说话简短，不爱表达情绪，\n喜欢用「嗯」「好」开头。常用口头禅：「慢慢来」。"}
                className="y-textarea" style={{ marginTop: 6 }} />
              <span style={{ color: "var(--text-hint)", fontSize: 11, marginTop: 4, display: "block" }}>
                这段话会影响对话的语气和用词风格，越具体越好。
              </span>
            </label>

            <button type="submit" disabled={submitting} className="y-btn" style={{ marginTop: 16, width: "100%" }}>
              {submitting ? "创建中…" : "创建并去录入记忆"}
            </button>
          </form>
        </div>
      )}

      {error && <div className="y-error">{error}</div>}
    </main>
    </AppShell>
  );
}
