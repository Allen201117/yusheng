"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    if (pathname === "/login") { setChecked(true); setAuthed(true); return; }
    fetch("/api/auth/check")
      .then((r) => { if (r.ok) setAuthed(true); else router.replace("/login"); })
      .catch(() => router.replace("/login"))
      .finally(() => setChecked(true));
  }, [pathname, router]);

  if (!checked) {
    return (
      <div style={{
        background: "var(--bg)", height: "100vh",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: 16,
      }}>
        <span style={{ fontSize: 36 }}>🕯️</span>
        <span style={{
          fontFamily: "var(--font-serif)", fontSize: 24,
          color: "var(--text)", letterSpacing: "0.08em",
        }}>
          余声
        </span>
      </div>
    );
  }
  if (!authed && pathname !== "/login") return null;
  return <>{children}</>;
}
