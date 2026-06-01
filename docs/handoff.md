# 余声 YuSheng v2 交接文档

> 最后更新：2026-06-01
> 版本：0.1.0 成熟 MVP
> 状态：核心闭环可运行，已补上用户级声音隔离和显式认证模式

## 产品定位

余声是一个 AI 声音记忆陪伴产品。用户上传或录制一段参考声音，创建一个人物，录入具体记忆，然后用文字对话，并听到克隆声音朗读回复。

核心流程：

```text
登录 -> 录参考声音 -> 创建人物 -> 录入记忆 -> 流式对话 -> 克隆声音朗读
```

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 15 App Router, React 18, TypeScript |
| API | Next.js Route Handlers, `runtime = "nodejs"` |
| 数据库 | better-sqlite3, WAL 模式 |
| 声音文件 | 本地 `data/voices`，meta 中记录 `userId` |
| ASR | SiliconFlow SenseVoiceSmall |
| Embedding | SiliconFlow bge-m3 |
| LLM | SiliconFlow DeepSeek-V3 |
| TTS | SiliconFlow CosyVoice2-0.5B |
| 邮件 | Resend，可选 |

## 当前实现

- 认证：默认 `AUTH_MODE=email`，邮箱 + 密码登录，首次登录自动注册。
- 开发免登：仅当显式设置 `AUTH_MODE=disabled` 时启用，返回 `userId="__dev__"`。
- 生产安全门：生产环境签发 session 时禁止使用默认 `SESSION_SECRET`。
- 数据隔离：personas 按 `user_id` 查询；memory/message 通过 persona 归属间接隔离。
- 声音隔离：新版 voice meta 写入 `userId`，上传列表、创建人物、TTS 均按当前用户校验。
- 旧声音兼容：旧 meta 没有 `userId` 时视为 `__legacy__`，仅 `__legacy__` 和 `__dev__` 可访问。
- 对话：`/api/chat` 使用 SSE 流式输出，召回 top 3 条相关记忆。
- 历史截断：读取最近 100 条，再按约 2000 token 估算截断。
- 语音合成：前端在收到完整 reply 后调用 `/api/tts` 播放克隆声音。
- 限流：TTS 使用进程内 Map 按用户每日计数。
- 自伤兜底：关键词命中时不调用 LLM，直接返回安全回复。

## 关键文件

```text
src/lib/auth.ts              认证模式、session 签名
src/lib/db.ts                SQLite schema 和数据访问
src/lib/voiceStore.ts        用户级声音文件存储
src/app/api/voice/upload     上传、ASR、列出当前用户声音
src/app/api/persona          人物 CRUD，绑定当前用户声音
src/app/api/memory           记忆 CRUD
src/app/api/chat             RAG + SSE 流式对话
src/app/api/tts              用户级 TTS 合成
src/app/voice/new/page.tsx   浏览器录音和上传
src/app/persona/[id]/chat    聊天 UI
```

## 环境变量

必填：

```bash
SILICONFLOW_API_KEY=sk-xxx
SESSION_SECRET=生产环境必须换成随机长字符串
AUTH_MODE=email
```

可选：

```bash
COSYVOICE_MODEL=FunAudioLLM/CosyVoice2-0.5B
ASR_MODEL=FunAudioLLM/SenseVoiceSmall
EMBEDDING_MODEL=BAAI/bge-m3
LLM_MODEL=deepseek-ai/DeepSeek-V3
TTS_DAILY_LIMIT=50
DATA_DIR=./data
RESEND_API_KEY=
EMAIL_FROM=余声 <onboarding@resend.dev>
```

本地演示免登：

```bash
AUTH_MODE=disabled
```

生产环境不要使用免登模式。

## 验证命令

```bash
npm test
npm run build
npm run lint
```

`npm run lint` 当前执行 `tsc --noEmit --pretty false`，是非交互式类型检查。项目尚未引入 ESLint 依赖。

## 已解决的关键风险

- 对话已从整段等待改为 SSE 流式输出。
- 对话历史不再硬编码 16 条，已按估算 token 截断。
- 浏览器录音已接入 MediaRecorder。
- 删除人物时会检查同一用户是否还有 persona 复用该 voice，避免误删共享声音。
- 声音列表、人物绑定、TTS 已按用户校验，避免直接枚举/复用他人 `voiceId`。
- 认证不再因为 `ACCESS_PASSWORD` 为空而默认免登。

## 剩余风险

| 优先级 | 问题 | 建议 |
|---|---|---|
| 高 | 参考声音仍存本地磁盘 | 接入对象存储，或至少实现加密备份和恢复流程 |
| 高 | 缺少完整同意与删除流程 | 增加上传授权提示、数据导出、彻底删除入口 |
| 中 | TTS 限流是进程内 Map | 多实例部署时改 Redis 或持久化限流 |
| 中 | SQLite schema 迁移靠代码内 ALTER | 引入轻量 migration 版本表 |
| 中 | 自伤检测只是关键词 | 增加更完整的安全分类和人工求助引导 |
| 低 | 无端到端浏览器测试 | 用 Playwright 覆盖登录、上传、创建、记忆、对话主链路 |

## 接手注意事项

1. 所有 API 路由都必须调用 `requireAuth()`，不要新开未鉴权入口。
2. 任何读取 voice 的地方都用 `loadVoiceForUser` 或 `readAudioBase64ForUser`。
3. 创建 persona 前必须校验 voice 属于当前用户。
4. 删除 persona 后，只有同一用户没有其他 persona 使用该 voice 时才删除声音文件。
5. `AUTH_MODE=disabled` 只用于本地演示和测试。
6. `data/` 不进 git，迁移部署时要单独备份 SQLite 和 voices。
7. 不要引入 ffmpeg 作为必需依赖，当前音频时长解析依赖纯 JS。
8. CosyVoice 零样本克隆高度依赖准确 reference text，ASR 结果需要允许用户修正。
