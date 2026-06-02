"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

type ResetStep = "idle" | "send" | "verify";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 重置密码状态
  const [reset, setReset] = useState<ResetStep>("idle");
  const [resetCode, setResetCode] = useState(["", "", "", "", "", ""]);
  const [resetPassword, setResetPassword] = useState("");
  const [resetCountdown, setResetCountdown] = useState(0);
  const resetRefs = useRef<(HTMLInputElement | null)[]>([]);

  // ---- 登录 ----
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!email.trim() || !email.includes("@")) { setError("请输入有效的邮箱"); return; }
    if (!password.trim() || password.length < 4) { setError("密码至少 4 位"); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password: password.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "登录失败");
      router.push("/"); router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  // ---- 发送重置验证码 ----
  async function handleSendResetCode() {
    if (!email.trim() || !email.includes("@")) return;
    setError(""); setLoading(true);
    try {
      const r = await fetch("/api/auth/send-code", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "发送失败");
      setReset("verify"); setResetPassword("");
      setResetCode(["", "", "", "", "", ""]);
      startResetCountdown();
      setTimeout(() => resetRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  function startResetCountdown() {
    setResetCountdown(60);
    const t = setInterval(() => setResetCountdown((p) => { if (p <= 1) { clearInterval(t); return 0; } return p - 1; }), 1000);
  }

  function handleResetCodeChange(i: number, val: string) {
    if (!/^\d?$/.test(val)) return;
    const next = [...resetCode]; next[i] = val; setResetCode(next);
    if (val && i < 5) resetRefs.current[i + 1]?.focus();
  }
  function handleResetKeyDown(i: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !resetCode[i] && i > 0) resetRefs.current[i - 1]?.focus();
  }
  function handleResetPaste(e: React.ClipboardEvent) {
    const p = e.clipboardData.getData("text").trim();
    if (!/^\d{6}$/.test(p)) return;
    e.preventDefault(); setResetCode(p.split("")); resetRefs.current[5]?.focus();
  }

  // ---- 提交重置 ----
  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fullCode = resetCode.join("");
    if (fullCode.length !== 6) { setError("请输入完整的验证码"); return; }
    if (!resetPassword || resetPassword.length < 4) { setError("新密码至少 4 位"); return; }
    setError(""); setLoading(true);
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: fullCode, password: resetPassword }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "重置失败");
      // 重置成功，自动登录
      setPassword(resetPassword);
      setReset("idle");
      const r2 = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password: resetPassword }),
      });
      const j2 = await r2.json();
      if (!r2.ok) throw new Error(j2.error || "登录失败");
      router.push("/"); router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  const digitStyle = (d: string): React.CSSProperties => ({
    width: 40, height: 46, textAlign: "center", fontSize: 20, fontWeight: 600,
    fontFamily: "SF Mono, monospace", color: "var(--text)",
    background: "var(--bg-input)",
    border: `1px solid ${d ? "var(--border-focus)" : "var(--border)"}`,
    borderRadius: "var(--radius-sm)", outline: "none",
    transition: "border-color 0.15s",
  });

  return (
    <main className="y-login-page">
      <div className="y-login-glow" />
      <div className="y-login-card">
        <div style={{ marginBottom: 24 }}>
          <h1 className="y-login-brand" style={{ marginBottom: 12 }}>余声</h1>
          <p className="y-login-tagline" style={{ marginBottom: 4 }}>有些声音，不该只留在记忆里</p>
          <p className="y-login-sub">
            首次输入邮箱和密码即自动注册
          </p>
        </div>

        <div className="y-login-divider" />

        {/* 重置密码流程 */}
        {reset === "verify" ? (
          <form onSubmit={handleResetSubmit}>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, textAlign: "center" }}>
              验证码已发送至 {email.trim().toLowerCase()}
            </p>

            <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 14 }}
              onPaste={handleResetPaste}>
              {resetCode.map((d, i) => (
                <input key={i} ref={(el) => { resetRefs.current[i] = el; }}
                  type="text" inputMode="numeric" maxLength={1} value={d}
                  onChange={(e) => handleResetCodeChange(i, e.target.value)}
                  onKeyDown={(e) => handleResetKeyDown(i, e)}
                  style={digitStyle(d)} />
              ))}
            </div>

            <input
              type="password" value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder="设置新密码（至少 4 位）"
              className="y-login-input"
              style={{ letterSpacing: "0.04em", textAlign: "left", paddingLeft: 16, marginBottom: 12 }}
            />

            <button type="submit" disabled={loading || resetCode.join("").length !== 6} className="y-login-btn">
              {loading ? "…" : "重置密码并登录"}
            </button>

            <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 14, fontSize: 13 }}>
              <button type="button" onClick={handleSendResetCode} disabled={resetCountdown > 0} style={{
                background: "none", border: "none",
                color: resetCountdown > 0 ? "var(--text-hint)" : "var(--text-accent)",
                cursor: resetCountdown > 0 ? "default" : "pointer", fontSize: 13,
              }}>
                {resetCountdown > 0 ? `${resetCountdown}s` : "重发"}
              </button>
              <button type="button" onClick={() => setReset("idle")} style={{
                background: "none", border: "none", color: "var(--text-hint)", cursor: "pointer", fontSize: 13,
              }}>
                返回
              </button>
            </div>
          </form>
        ) : (
          <>
            {/* 正常登录 */}
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                type="email" value={email}
                onChange={(e) => { setEmail(e.target.value); setError(""); setReset("idle"); }}
                placeholder="your@email.com" autoFocus
                className="y-login-input"
                style={{ letterSpacing: "0.04em", textAlign: "left", paddingLeft: 16 }}
              />
              <input
                type="password" value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                placeholder={reset === "send" ? "新密码" : "设置或输入密码"}
                className="y-login-input"
                style={{ letterSpacing: "0.04em", textAlign: "left", paddingLeft: 16 }}
              />
              <button type="submit" disabled={loading} className="y-login-btn">
                {loading ? "处理中" : "进入余声"}
              </button>
            </form>

            {/* 忘记密码 */}
            {error && error.includes("密码错误") && (
              <button
                type="button"
                onClick={() => { setReset("send"); handleSendResetCode(); }}
                style={{
                  display: "block", width: "100%", textAlign: "center", marginTop: 12,
                  background: "none", border: "none",
                  color: "var(--text-accent)", cursor: "pointer",
                  fontSize: 12, fontFamily: "var(--font-sans)",
                  opacity: loading ? 0.5 : 1,
                }}
                disabled={loading}
              >
                忘记密码？通过验证码重置
              </button>
            )}
          </>
        )}

        {error && <div className="y-error" style={{ marginTop: 16 }}>{error}</div>}

        <p className="y-login-footer">
          这是一个私密空间。
          <br />
          请安静地进入。
        </p>
      </div>
    </main>
  );
}
