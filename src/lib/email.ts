/**
 * 消息发送 — 邮件（Resend）+ 短信（终端打码 / 预留 SMS 接口）
 *
 * 邮件：Resend，免费 100 封/天，测试域名 onboarding@resend.dev 无需自有域名
 * 短信：MVP 阶段打印到终端。生产可接入阿里云/腾讯云短信。
 */

// ---- 邮件 ----
let _resend: any = null;
function getResend() {
  if (_resend) return _resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  const { Resend } = require("resend");
  _resend = new Resend(apiKey);
  return _resend;
}

export async function sendEmailCode(
  toEmail: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  // 始终打到终端，方便调试
  console.log(`\n[DEV] 邮箱验证码 → ${toEmail}: ${code}\n`);

  const resend = getResend();
  if (!resend) return { ok: true };  // 没配 key，终端打码够了

  // 配了 Resend：尝试真发邮件。失败不阻塞，终端还有码
  try {
    const from = process.env.EMAIL_FROM || "余声 <onboarding@resend.dev>";
    const { error } = await resend.emails.send({
      from,
      to: toEmail,
      subject: "余声 — 登录验证码",
      html: emailTemplate(code),
    });

    if (error) {
      console.error("[email] Resend 发送失败:", error.message);
      console.log("[email] 验证码已在终端，可手动使用");
      // 不报错：终端有码，用户不受影响
    }
  } catch (err) {
    console.error("[email] Resend 异常:", String(err));
  }
  return { ok: true };
}

function emailTemplate(code: string) {
  return `
    <div style="max-width:400px;margin:0 auto;padding:40px 20px;font-family:-apple-system,PingFang SC,sans-serif;color:#3d3229;background:#faf6f1">
      <h1 style="font-family:Noto Serif SC,Songti SC,Georgia,serif;font-size:28px;font-weight:600;text-align:center;color:#3d3229;letter-spacing:0.08em;margin-bottom:32px">余声</h1>
      <p style="font-size:15px;line-height:1.8;text-align:center;color:#7a6e62;margin-bottom:24px">你的登录验证码</p>
      <div style="background:#fff;border:1px solid #e4ddd4;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px">
        <span style="font-family:SF Mono,monospace;font-size:32px;letter-spacing:0.15em;color:#a07850;font-weight:600">${code}</span>
      </div>
      <p style="font-size:13px;color:#a99d90;text-align:center;line-height:1.8">验证码 5 分钟内有效。<br>如果这不是你操作的，请忽略这封邮件。</p>
    </div>`;
}

// ---- 短信（MVP: 终端打码，生产接入 SMS 服务） ----
export async function sendSmsCode(
  phone: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  // TODO: 接入阿里云/腾讯云短信服务
  // const client = new SMSClient({ accessKeyId, accessKeySecret });
  // await client.send({ phone, templateCode, templateParam: { code } });

  console.log(`\n[DEV] 短信验证码 → ${phone}: ${code}\n`);
  return { ok: true };
}
