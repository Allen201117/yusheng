"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { use } from "react";
import AppShell from "@/components/AppShell";

type Memory = { id: string; content: string; createdAt: string };

export default function MemoriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: personaId } = use(params);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [bulk, setBulk] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/memory?personaId=${personaId}`);
      setMemories((await r.json()).memories || []);
    } catch {}
    setLoaded(true);
  }
  useEffect(() => { refresh(); }, [personaId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault(); setError("");
    const lines = bulk.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return setError("一条都没填");
    setSubmitting(true);
    try {
      const r = await fetch("/api/memory", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId, contents: lines }),
      });
      if (!r.ok) throw new Error(((await r.json()).error || "保存失败"));
      setBulk("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSubmitting(false); }
  }

  async function handleDelete(id: string) {
    if (confirmDelete !== id) return setConfirmDelete(id);
    try { await fetch(`/api/memory?id=${id}`, { method: "DELETE" }); } catch {}
    setConfirmDelete(null);
    await refresh();
  }

  return (
    <AppShell>
    <main className="y-page">
      <div className="y-nav">
        <Link href="/" className="y-nav-back">← 首页</Link>
        <Link href={`/persona/${personaId}/chat`} className="y-btn-ghost y-btn-sm">💬 对话</Link>
      </div>

      <h1 className="y-title">记忆</h1>
      <p className="y-subtitle">
        每行一条，越具体越好。这些记忆会被 AI 理解，对话时自动召回相关的。
      </p>

      {/* 录入 */}
      <div className="y-card" style={{ marginTop: 24 }}>
        <h2 className="y-card-title">📝 录入新记忆</h2>
        <form onSubmit={handleAdd}>
          <textarea
            value={bulk} onChange={(e) => setBulk(e.target.value)} rows={6}
            className="y-textarea"
            placeholder={"爸爸 2018 年带我去青岛玩，住在海边的民宿\n他最喜欢吃妈妈做的红烧肉\n他生前每天早上都听广播\n他总叫我「小宝」\n他走的时候我没能见上最后一面"}
          />
          <button type="submit" disabled={submitting} className="y-btn" style={{ marginTop: 12, width: "100%" }}>
            {submitting ? "向量化并保存中…" : "💾 保存"}
          </button>
        </form>
      </div>

      {/* 列表 */}
      <div className="y-card">
        <h2 className="y-card-title">📋 已录入（{memories.length}）</h2>
        {!loaded ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3].map((n) => <div key={n} className="y-skeleton" style={{ height: 40 }} />)}
          </div>
        ) : memories.length === 0 ? (
          <div className="y-empty-warm" style={{ padding: "var(--sp-lg) 0" }}>
            <span className="y-empty-emoji" style={{ fontSize: 32 }}>📭</span>
            <p style={{ color: "var(--text-hint)", fontSize: 13, margin: 0 }}>
              还没有记忆
              <br />
              <span style={{ fontSize: 12 }}>一段记忆，就是一封寄不出的信</span>
            </p>
          </div>
        ) : (
          <div>
            {memories.map((m) => (
              <div key={m.id} className="y-memory-item">
                <span className="y-memory-bullet">✦</span>
                <span className="y-memory-text">{m.content}</span>
                <button
                  onClick={() => handleDelete(m.id)}
                  onBlur={() => setConfirmDelete(null)}
                  className={`y-btn-ghost y-btn-sm ${confirmDelete === m.id ? "y-btn-danger" : ""}`}
                  style={{ flexShrink: 0, marginLeft: 8 }}
                >
                  {confirmDelete === m.id ? "确认?" : "删除"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="y-error">{error}</div>}
    </main>
    </AppShell>
  );
}
