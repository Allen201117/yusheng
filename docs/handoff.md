# 余声 YuSheng v2 — 项目交接文档

> 最后更新：2026-05-25
> 版本：0.0.1 (Slice 3)
> 状态：核心闭环可用，有已知待优化项

---

## 一、产品概述

### 1.1 产品定位

**余声**是一个 AI 声音记忆陪伴产品。用户上传逝去亲人的参考声音，录入关于这个人的记忆片段，然后就能和这个"声音复现"的人对话。AI 不仅模仿他的声音（TTS 声音克隆），还会基于录入的记忆用他的语气说话（LLM 角色扮演 + RAG 记忆召回）。

### 1.2 核心用户流程

```
录参考声音 → 创建人物 → 录入记忆 → 对话（文字 + 语音）
```

1. **录一段参考声音**：上传 25 秒以内的清晰人声音频，系统自动识别文字稿（ASR），也可以手填
2. **创建一个人物**：填写姓名、关系、性格描述，绑定参考声音
3. **录入记忆**：每行一条，系统自动向量化存入数据库，对话时按相关性召回
4. **对话**：打字聊天，AI 用那个人的语气回复，可以点"再听一遍"听到克隆声音朗读

### 1.3 设计风格

**「暖光旧信」**——温暖浅底 + 琥珀棕点缀。像在一间午后的老房子里翻出泛黄的信件。完整设计规范见 `docs/design.md`。

---

## 二、技术架构

### 2.1 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端框架 | Next.js 15 (App Router) | React 18, TypeScript |
| 后端运行时 | Node.js (Next.js API Routes) | `runtime = "nodejs"` 全部走 Node |
| 数据库 | better-sqlite3 | 单文件 SQLite，WAL 模式，同步 API |
| 声音克隆 | SiliconFlow CosyVoice2-0.5B | 零样本克隆，参考音频 base64 随请求传 |
| 语音识别 | SiliconFlow SenseVoiceSmall | OpenAI Whisper 兼容格式 |
| 文本向量化 | SiliconFlow bge-m3 | 1024 维，中英文 |
| LLM | SiliconFlow DeepSeek-V3 | OpenAI 兼容 chat/completions |
| 认证 | 共享密码 + Cookie Session | MVP 阶段，预留飞书 OAuth 替换口 |

### 2.2 外部服务依赖

全部走 **SiliconFlow** 一个 API Key（`SILICONFLOW_API_KEY`），申请地址：https://cloud.siliconflow.cn/account/ak

- TTS：`POST https://api.siliconflow.cn/v1/audio/speech`
- ASR：`POST https://api.siliconflow.cn/v1/audio/transcriptions`
- Embedding：`POST https://api.siliconflow.cn/v1/embeddings`
- Chat：`POST https://api.siliconflow.cn/v1/chat/completions`

### 2.3 项目结构

```
yusheng-v2/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # 根 layout，挂 AuthGuard
│   │   ├── globals.css             # 全局样式（暖光旧信设计系统）
│   │   ├── page.tsx                # 首页：人物列表
│   │   ├── login/page.tsx          # 登录页
│   │   ├── persona/
│   │   │   ├── new/page.tsx        # 创建人物
│   │   │   └── [id]/
│   │   │       ├── chat/page.tsx   # 对话页
│   │   │       └── memories/page.tsx # 记忆管理
│   │   ├── voice/new/page.tsx      # 上传参考声音
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── check/route.ts  # 鉴权检查
│   │       │   ├── login/route.ts  # 登录
│   │       │   └── logout/route.ts # 登出
│   │       ├── chat/route.ts       # 对话（LLM + RAG）
│   │       ├── memory/route.ts     # 记忆 CRUD
│   │       ├── persona/route.ts    # 人物 CRUD
│   │       ├── tts/route.ts        # 语音合成
│   │       └── voice/
│   │           ├── upload/route.ts # 参考音频上传 + ASR
│   │           └── transcribe/route.ts # 单独 ASR 接口
│   ├── components/
│   │   ├── AuthGuard.tsx           # 客户端鉴权守卫
│   │   └── ui.ts                   # 通用 UI 组件（预留）
│   └── lib/
│       ├── asr.ts                  # ASR 客户端（SenseVoiceSmall）
│       ├── audioProbe.ts           # 音频时长解析（纯 JS，不依赖 ffmpeg）
│       ├── auth.ts                 # 认证模块（HMAC-SHA256 签名 session）
│       ├── cosyvoice.ts            # TTS 声音克隆客户端
│       ├── db.ts                   # SQLite 数据层（personas/memories/messages）
│       ├── embedding.ts            # 文本向量化客户端
│       ├── guard.ts                # API 路由鉴权守卫
│       ├── llm.ts                  # LLM 客户端
│       ├── logger.ts               # 简易日志
│       ├── rateLimit.ts            # TTS 速率限制（内存 Map）
│       └── voiceStore.ts           # 参考音频文件存储
├── data/                           # 运行时数据（.gitignore）
│   ├── yusheng.sqlite              # SQLite 数据库
│   └── voices/                     # 参考音频 + meta.json
├── docs/
│   └── design.md                   # 前端设计规范
├── .env.local                      # 环境变量（不入库）
├── .env.example                    # 环境变量模板
├── package.json
└── tsconfig.json
```

### 2.4 数据库 Schema

```sql
-- 人物表
CREATE TABLE personas (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT '__legacy__',
  name         TEXT NOT NULL,
  relation     TEXT NOT NULL,
  voice_id     TEXT NOT NULL,
  persona_desc TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- 记忆表（embedding 存 BLOB，Float32Array）
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   BLOB,
  created_at  TEXT NOT NULL
);

-- 聊天消息表
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

### 2.5 认证流程

```
浏览器 → AuthGuard → fetch /api/auth/check → cookie 有效？
                                              ├─ 是 → 渲染页面
                                              └─ 否 → redirect /login

登录页 → POST /api/auth/login → 验证密码 → set-cookie (HMAC-SHA256 签名)
```

- 未设 `ACCESS_PASSWORD` 时跳过鉴权（开发模式）
- Cookie 有效期 7 天，`httpOnly + secure + sameSite=lax`
- 所有 API 路由都走 `requireAuth(req)` 校验

### 2.6 对话 + RAG 流程

```
用户发消息 → embedOne(text) → 加载该人物所有记忆的 embedding
→ cosineSim 排序 → 取 TOP 3 (score >= 0.35)
→ 拼入 system prompt → chatComplete() → 返回 reply
→ 同时 TTS 合成语音 → 前端播放
```

---

## 三、功能完成度

### 3.1 已完成 ✅

| 功能 | 说明 |
|---|---|
| 参考声音上传 | 支持 wav/mp3/m4a，≤25秒，≤20MB |
| ASR 自动识别 | 点击"自动识别"或文字稿留空自动触发 |
| M4A 时长解析 | 纯 JS 解析 MP4 box，支持 size=0/1/extended |
| 人物创建 | 绑定声音 + 性格描述 |
| 记忆录入 | 批量录入，自动向量化 |
| 记忆删除 | 两步确认（删除 → 确认?），有越权校验 |
| 对话 | LLM 角色扮演 + RAG 记忆召回 |
| 语音合成 | CosyVoice2 零样本克隆，对话后自动播放 |
| 认证 | 共享密码登录，无密码时免登 |
| 速率限制 | TTS 每用户每天 50 次 |
| 自伤检测 | 关键词兜底 + 安全回复 + 热线电话 |
| 暖光旧信 UI | 完整设计系统，6 个页面全部重写 |
| Blob URL 管理 | 自动释放避免内存泄漏 |

### 3.2 已修复的 Bug 清单

| Bug | 修复 |
|---|---|
| TTS 硬编码 audio/wav MIME | 保存时记录原始 MIME，TTS 使用真实类型 |
| 音频文件扩展名全存 .wav | 按 MIME 推断正确扩展名 |
| "播放中"动画出现在所有 AI 气泡 | 只在最后一条 AI 消息显示 |
| Blob URL 内存泄漏 | 追踪 + 自动释放 + 组件卸载清理 |
| 删除记忆无越权校验 | 先查归属再校验 |
| fetch 无 catch | 全部加 .catch() 兜底 |
| rateLimit LIMIT 可能为 NaN | parseInt 后校验 Number.isFinite |
| setTimeout 50ms 播放不可靠 | 改用 onloadeddata 事件 |

---

## 四、环境配置

### 4.1 .env.local 必填项

```bash
# SiliconFlow API Key（TTS/ASR/Embedding/LLM 共用）
SILICONFLOW_API_KEY=sk-xxx

# 访问密码（不设则免登录，仅限开发）
ACCESS_PASSWORD=

# Session 签名密钥（生产务必改掉默认值）
SESSION_SECRET=yusheng-v2-change-me-in-prod
```

### 4.2 .env.local 可选项

```bash
COSYVOICE_MODEL=FunAudioLLM/CosyVoice2-0.5B
ASR_MODEL=FunAudioLLM/SenseVoiceSmall
EMBEDDING_MODEL=BAAI/bge-m3
LLM_MODEL=deepseek-ai/DeepSeek-V3
TTS_DAILY_LIMIT=50
DATA_DIR=./data
```

### 4.3 启动命令

```bash
npm install
npm run build
npm start
# 或开发模式：npm run dev
```

---

## 五、已知问题与待优化项

### 5.1 功能性卡点（影响体验，需优先处理）

| # | 问题 | 严重度 | 说明 | 建议 |
|---|---|---|---|---|
| 1 | **对话无流式输出** | 高 | 目前 LLM 返回完整 reply 后才显示，等待时间长（3-8 秒），用户可能以为卡了 | 接入 SSE 流式输出，逐字显示。SiliconFlow 的 chat/completions 支持 `stream: true` |
| 2 | **对话历史只取最近 16 条** | 中 | `listMessages(personaId, 16)` 硬编码，长对话会丢失早期上下文 | 改为按 token 长度动态截断，或让用户翻页加载 |
| 3 | **音频文件全存本地磁盘** | 中 | 参考音频存在 `data/voices/`，换机器/重启丢失，无法多实例部署 | 接入对象存储（TOS / S3），或至少加备份机制 |
| 4 | **RAG 召回全量加载** | 低 | `loadMemoriesWithEmbeddings` 加载该人物所有记忆的 embedding 到内存，记忆量大时慢 | 改为 SQLite 向量扩展（sqlite-vec）或引入专用向量库 |
| 5 | **手机录音上传体验差** | 中 | 目前只能选文件，无法直接录音 | 加 MediaRecorder API 录音功能 |

### 5.2 安全与稳定性

| # | 问题 | 严重度 | 说明 |
|---|---|---|---|
| 6 | SESSION_SECRET 默认值不安全 | 高 | 生产环境必须换掉 `yusheng-v2-change-me-in-prod`，否则 session 可被伪造 |
| 7 | 速率限制存内存 | 低 | 服务重启后计数清零，多实例不共享。MVP 够用，上规模需换 Redis |
| 8 | 无 HTTPS 强制 | 中 | `secure: true` 仅在 `NODE_ENV=production` 生效，开发环境 cookie 明文传输 |
| 9 | 删除人物无级联清理 | 中 | 删除 persona 时 memories/messages 级联删了（SQL ON DELETE CASCADE），但 voiceStore 里的音频文件没清 |

### 5.3 体验优化

| # | 问题 | 优先级 | 说明 |
|---|---|---|---|
| 10 | 对话页底部输入栏遮挡内容 | 中 | `paddingBottom: 120` 是硬编码的，不同设备可能不够 |
| 11 | 气泡内"再听一遍"按钮换行 | 低 | AI 气泡末尾的播放按钮和文字挤在一行，长文本时视觉不好 |
| 12 | 无加载进度反馈 | 低 | TTS 生成需要几秒，目前只显示"播放中"跳动动画，缺少进度提示 |
| 13 | 记忆无编辑功能 | 低 | 只能删除重录，不支持修改 |
| 14 | 参考音频无法重录/替换 | 低 | 绑定后无法更换参考声音 |
| 15 | 对话无法清空/重置 | 低 | 没有清空聊天记录的入口 |

### 5.4 架构改进

| # | 问题 | 优先级 | 说明 |
|---|---|---|---|
| 16 | 认证方案待升级 | 中 | 当前共享密码模式无法区分用户，换飞书 OAuth 后 userId 变 open_id，其余零改动 |
| 17 | 多用户数据隔离 | 中 | 目前 user_id 隔离仅在 SQL 层，共享密码模式下所有人都是 "user"，实际没隔离 |
| 18 | 无数据库迁移工具 | 低 | schema 变更靠 ALTER TABLE 硬编码，无版本管理 |
| 19 | 无日志持久化 | 低 | logger 只 console.log，无文件/远程日志 |

---

## 六、关键代码逻辑说明

### 6.1 对话流程（chat/route.ts）

1. 校验 auth → 校验 persona 归属
2. 写入用户消息到 messages 表
3. 自伤关键词检测（命中则返回安全回复 + 热线）
4. RAG 召回：embedOne(text) → cosineSim 排序 → TOP 3 (score >= 0.35)
5. 拼装 system prompt（角色设定 + 性格 + 记忆块）
6. 载入最近 16 条历史消息作为上下文
7. chatComplete() → 写入 AI 回复到 messages 表
8. 前端收到 reply 后自动调用 speak() → TTS 合成 + 播放

### 6.2 声音上传流程（voice/upload/route.ts）

1. 校验 auth → 校验文件类型和大小
2. probeAudioDuration() 纯 JS 解析时长（WAV/MP3/M4A）
3. 时长超过 25 秒拒绝
4. 如果用户没填文字稿 → transcribeAudio() 自动 ASR
5. saveVoice() 保存音频文件 + meta.json
6. 返回 voiceId

### 6.3 认证守卫

- 前端：AuthGuard 组件每次路由变化调 `/api/auth/check`
- 后端：每个 API route handler 调 `requireAuth(req)`
- 未设密码时：`isAuthConfigured() = false` → 直接放行，userId = `"__dev__"`

### 6.4 RAG 记忆检索

- 记忆录入时：`embedOne(content)` → 1024 维 Float32 → 存 BLOB
- 对话时：`embedOne(用户输入)` → 和所有记忆算 cosineSim → 取 TOP 3
- 阈值 0.35，低于此视为不相关，不注入 prompt

---

## 七、API 接口清单

| 方法 | 路径 | 说明 | 认证 |
|---|---|---|---|
| GET | `/api/auth/check` | 检查登录状态 | - |
| POST | `/api/auth/login` | 登录 | - |
| POST | `/api/auth/logout` | 登出 | - |
| GET | `/api/persona` | 列出人物 | ✅ |
| POST | `/api/persona` | 创建人物 | ✅ |
| GET | `/api/memory?personaId=xxx` | 列出记忆 | ✅ |
| POST | `/api/memory` | 录入记忆（批量） | ✅ |
| DELETE | `/api/memory?id=xxx` | 删除记忆 | ✅ |
| GET | `/api/chat?personaId=xxx` | 获取对话历史 | ✅ |
| POST | `/api/chat` | 发送消息 | ✅ |
| POST | `/api/tts` | 语音合成 | ✅ |
| GET | `/api/voice/upload` | 列出参考声音 | ✅ |
| POST | `/api/voice/upload` | 上传参考声音 | ✅ |
| POST | `/api/voice/transcribe` | 单独 ASR 识别 | ✅ |

---

## 八、给接手 Agent 的注意事项

1. **SiliconFlow API Key 是唯一外部依赖**，所有 AI 能力（TTS/ASR/Embedding/LLM）都靠它
2. **数据库是 better-sqlite3**，同步 API，不需要 await。但 voiceStore 的 fs 操作是异步的
3. **Next.js 15 App Router**，`params` 是 Promise 类型，页面组件里用 `use(params)` 解包
4. **不要引入 ffmpeg**，音频时长解析用纯 JS（audioProbe.ts），服务器可能没装 ffmpeg
5. **runtime 必须是 "nodejs"**，better-sqlite3 和 crypto.subtle 不支持 Edge Runtime
6. **设计系统在 globals.css**，所有 CSS 变量和组件样式都在那里，新增组件优先复用已有 class
7. **MVP 阶段不做飞书 OAuth**，认证用共享密码，但 `AUTH_MODE` 预留了 `"feishu"` 值
8. **data/ 目录在 .gitignore**，数据库和音频文件不入库，迁移时需要单独处理
9. **自伤检测是关键词匹配**，不是 NLP，可能漏检也可能误检，未来需要升级
10. **CosyVoice 零样本克隆需要参考音频的文字稿**，这是 API 硬性要求，ASR 就是为此而加的
