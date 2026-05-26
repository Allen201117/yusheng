"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

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

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/persona")
      .then((r) => r.json())
      .then((j) => setPersonas(j.personas || []))
      .catch(() => {});
  }, [pathname]); // 每次路由变化刷新

  const isActive = (id: string) => pathname.includes(`/persona/${id}`);

  return (
    <>
      {/* 移动端遮罩 */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.2)",
            zIndex: 19, display: "none",
          }}
          className="y-sidebar-overlay"
        />
      )}

      <aside
        style={{
          position: "fixed", top: 0, left: 0, bottom: 0,
          width: 260, zIndex: 20,
          background: "var(--bg-card)",
          borderRight: "1px solid var(--border-light)",
          display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.25s var(--ease-out)",
        }}
        className="y-sidebar"
      >
        {/* 头部 */}
        <div style={{ padding: "20px 16px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Link href="/" onClick={onClose} style={{
              fontFamily: "var(--font-serif)", fontSize: 20,
              fontWeight: 600, color: "var(--text)",
              letterSpacing: "0.06em", textDecoration: "none",
            }}>
              🕯️ 余声
            </Link>
            <button onClick={onClose} style={{
              background: "none", border: "none", color: "var(--text-hint)",
              cursor: "pointer", fontSize: 18, padding: "4px 6px",
              display: "none",
            }} className="y-sidebar-close">
              ✕
            </button>
          </div>
        </div>

        {/* 新建 */}
        <div style={{ padding: "0 12px 8px" }}>
          <Link
            href="/persona/new"
            onClick={onClose}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px dashed var(--border)",
              color: "var(--text-secondary)",
              fontSize: 13, textDecoration: "none",
              transition: "border-color 0.15s, color 0.15s",
            }}
          >
            <span>＋</span>
            <span>新建人物</span>
          </Link>
        </div>

        {/* 人物列表 */}
        <nav style={{ flex: 1, overflow: "auto", padding: "4px 12px" }}>
          {personas.length === 0 ? (
            <p style={{
              padding: "20px 12px", fontSize: 12, color: "var(--text-hint)",
              textAlign: "center", lineHeight: 1.8,
            }}>
              还没有人物
              <br />
              去录一段声音开始
            </p>
          ) : (
            personas.map((p) => {
              const active = isActive(p.id);
              const emoji = pickEmoji(p.name, p.relation);
              return (
                <Link
                  key={p.id}
                  href={`/persona/${p.id}/chat`}
                  onClick={onClose}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-sm)",
                    background: active ? "var(--accent-soft)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-secondary)",
                    textDecoration: "none",
                    fontSize: 13, fontWeight: active ? 500 : 400,
                    transition: "background 0.15s",
                    marginBottom: 2,
                  }}
                >
                  <span style={{ fontSize: 18, flexShrink: 0 }}>{emoji}</span>
                  <span style={{
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {p.name}
                  </span>
                  <span style={{
                    fontSize: 10, color: "var(--text-hint)",
                    flexShrink: 0,
                  }}>
                    {p.relation}
                  </span>
                </Link>
              );
            })
          )}
        </nav>

        {/* 底部 */}
        <div style={{ padding: "12px", borderTop: "1px solid var(--border-light)" }}>
          <Link
            href="/voice/new"
            onClick={onClose}
            style={{
              display: "block", padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              fontSize: 12, textDecoration: "none",
              transition: "background 0.15s",
            }}
          >
            🎙️ 录声音
          </Link>
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              location.href = "/login";
            }}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "8px 12px", marginTop: 2,
              borderRadius: "var(--radius-sm)",
              background: "none", border: "none",
              color: "var(--text-hint)", fontSize: 12,
              cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
          >
            离开
          </button>
        </div>
      </aside>
    </>
  );
}
