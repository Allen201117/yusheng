"use client";

import { useState } from "react";
import Sidebar from "./Sidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* 移动端遮罩 */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="y-sidebar-overlay"
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.25)",
            zIndex: 19,
          }}
        />
      )}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* 主体 */}
      <div style={{
        flex: 1, minWidth: 0,
        marginLeft: 0,
      }} className="y-main-area">
        {/* 汉堡按钮（移动端） */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="y-hamburger"
          style={{
            position: "fixed", top: 12, left: 12,
            zIndex: 10, width: 36, height: 36,
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-card)",
            border: "1px solid var(--border-light)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", fontSize: 18,
            color: "var(--text-secondary)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          菜单
        </button>

        {children}
      </div>

      <style>{`
        @media (min-width: 768px) {
          .y-sidebar {
            transform: translateX(0) !important;
            position: sticky !important;
            top: 0;
            height: 100vh;
            z-index: 1 !important;
          }
          .y-sidebar-overlay { display: none !important; }
          .y-hamburger { display: none !important; }
          .y-main-area {
            padding-left: 0 !important;
          }
        }
      `}</style>
    </div>
  );
}
