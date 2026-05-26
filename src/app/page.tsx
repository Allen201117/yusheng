"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";

type Persona = {
  id: string;
  name: string;
  relation: string;
  voiceId: string;
  personaDesc: string;
  createdAt: string;
};

const relationEmoji: Record<string, string> = {
  "父亲": "👨", "爸爸": "👨", "母亲": "👩", "妈妈": "👩",
  "外婆": "👵", "奶奶": "👵", "外公": "👴", "爷爷": "👴",
  "朋友": "💫", "爱人": "💕", "伴侣": "💕",
  "兄弟": "🤝", "姐妹": "🌸", "孩子": "👶",
};

function pickEmoji(name: string, relation: string): string {
  for (const [k, v] of Object.entries(relationEmoji)) {
    if (relation.includes(k) || name.includes(k)) return v;
  }
  return "💌";
}

export default function HomePage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function refresh() {
    fetch("/api/persona")
      .then((r) => r.json())
      .then((j) => setPersonas(j.personas || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []);

  async function handleDelete(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    try { await fetch(`/api/persona?id=${id}`, { method: "DELETE" }); } catch {}
    setConfirmDelete(null);
    refresh();
  }

  return (
    <AppShell>
      <main className="y-page">
        {/* 顶部 */}
        <header className="y-nav">
          <div>
            <h1 className="y-title">余声</h1>
            <p style={{ color: "var(--text-hint)", fontSize: 12, marginTop: 2 }}>
              ✦ 重新听到那个人的声音
            </p>
          </div>
        </header>

      {/* 加载态 */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="y-skeleton" style={{ height: 100 }} />
          <div className="y-skeleton" style={{ height: 100 }} />
        </div>
      ) : personas.length === 0 ? (
        /* 空状态 */
        <div className="y-empty-warm">
          <span className="y-empty-emoji">🕯️</span>
          <h2 className="y-empty-title">这里还很安静</h2>
          <p className="y-empty-desc">
            录一段那个人的声音，创建一个人物，
            然后就能在这里跟他说说话了。
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <Link href="/voice/new" className="y-btn" style={{ fontSize: 13 }}>
              🎙️ 录一段声音
            </Link>
            <Link href="/persona/new" className="y-btn-ghost" style={{ fontSize: 13 }}>
              创建人物
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* 人物列表 */}
          <p style={{
            color: "var(--text-secondary)", fontSize: 12,
            marginBottom: 16, letterSpacing: "0.04em",
          }}>
            你在思念谁
          </p>

          {personas.map((p, idx) => {
            const emoji = pickEmoji(p.name, p.relation);
            const date = new Date(p.createdAt).toLocaleDateString("zh-CN", {
              year: "numeric", month: "long", day: "numeric",
            });
            return (
              <div key={p.id} className="y-persona-card" style={{ animation: `fadeUp 0.4s var(--ease-out) ${idx * 0.06}s both` }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <div className="y-persona-avatar">{emoji}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="y-persona-name">{p.name}</span>
                      <span className="y-tag">{p.relation}</span>
                    </div>
                    <div className="y-persona-date">
                      {p.personaDesc
                        ? p.personaDesc.slice(0, 40) + (p.personaDesc.length > 40 ? "…" : "")
                        : `创建于 ${date}`}
                    </div>
                  </div>
                </div>

                <div className="y-persona-actions">
                  <Link href={`/persona/${p.id}/chat`} className="y-btn y-btn-sm">
                    💬 对话
                  </Link>
                  <Link href={`/persona/${p.id}/memories`} className="y-btn-ghost y-btn-sm">
                    📝 记忆
                  </Link>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => handleDelete(p.id)}
                    onBlur={() => setConfirmDelete(null)}
                    className={`y-btn-ghost y-btn-sm ${confirmDelete === p.id ? "y-btn-danger" : ""}`}
                  >
                    {confirmDelete === p.id ? "确认删除?" : "🗑️"}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* 底部操作 */}
      <hr className="y-divider" />

      <div style={{ display: "flex", gap: 8 }}>
        <Link href="/voice/new" className="y-btn-ghost" style={{ flex: 1, textAlign: "center", fontSize: 13 }}>
          🎙️ 录声音
        </Link>
        <Link href="/persona/new" className="y-btn-ghost" style={{ flex: 1, textAlign: "center", fontSize: 13 }}>
          ✨ 建人物
        </Link>
      </div>
    </main>
    </AppShell>
  );
}
