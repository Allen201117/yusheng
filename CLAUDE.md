# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

- 项目名称：余声 v2（YuSheng）
- 项目类型：AI 声音记忆陪伴机器人 — Next.js 15 Web 应用
- 主要技术栈：Next.js 15 (App Router) + React 18 + TypeScript + better-sqlite3
- 包管理器：npm
- 外部服务：SiliconFlow（TTS/ASR/Embedding/LLM 全部走一个 API Key）
- Node 版本：>=22

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发启动（localhost:3000）
npm run build        # 生产构建
npm start            # 生产启动
npm run lint         # ESLint
node --test tests/*.test.js  # 运行测试
```

## 目录结构

```
src/
  app/
    layout.tsx / globals.css     # 根布局 + 暖光旧信设计系统
    page.tsx                     # 首页：人物列表
    login/page.tsx               # 共享密码登录
    persona/
      new/page.tsx               # 创建人物（绑定声音+性格描述）
      [id]/chat/page.tsx         # 对话页（LLM 角色扮演 + 语音播放）
      [id]/memories/page.tsx     # 记忆录入与管理
    voice/new/page.tsx           # 上传参考声音 + 试听克隆效果
    api/
      auth/check|login|logout/   # 认证相关
      chat/route.ts              # 对话（RAG 召回 + LLM）
      memory/route.ts            # 记忆 CRUD + 向量化
      persona/route.ts           # 人物 CRUD
      tts/route.ts               # TTS 语音合成（CosyVoice 零样本克隆）
      voice/upload|transcribe/   # 参考音频上传 + ASR
  components/
    AuthGuard.tsx                # 客户端鉴权守卫（调 /api/auth/check）
  lib/
    auth.ts       # HMAC-SHA256 签名 session
    guard.ts      # API 路由鉴权守卫（requireAuth）
    db.ts         # SQLite 数据层（personas/memories/messages）
    cosyvoice.ts  # CosyVoice2-0.5B TTS 客户端
    asr.ts        # SenseVoiceSmall ASR 客户端
    llm.ts        # DeepSeek-V3 LLM 客户端
    embedding.ts  # bge-m3 向量化 + cosineSim
    voiceStore.ts # 参考音频文件存储
    audioProbe.ts # 纯 JS 音频时长解析（WAV/MP3/M4A，无 ffmpeg）
    logger.ts     # 结构化日志（console + 文件）
    rateLimit.ts  # TTS 速率限制（内存 Map，每用户每天 50 次）
data/              # 运行时数据（gitignore）— SQLite + 音频文件 + 日志
docs/              # 设计规范 + 接入笔记 + 交接文档
```

## 核心架构

### 用户流程
```
录参考声音 → 创建人物 → 录入记忆 → 对话（文字 + 语音克隆播放）
```

### 对话 + RAG 流程
```
用户发消息 → embedOne(text) → cosineSim 排序 → TOP 3 记忆召回
→ 拼入 system prompt → chatComplete() → 写入 AI reply
→ 前端自动调 /api/tts → CosyVoice 克隆语音播放
```

### 数据库（better-sqlite3，同步 API，WAL 模式）
- `personas` — 人物（id, user_id, name, relation, voice_id, persona_desc）
- `memories` — 记忆（id, persona_id, content, embedding BLOB, 级联删除）
- `messages` — 聊天记录（id, persona_id, role, content, 级联删除）

### 认证
- 共享密码 + cookie session（HMAC-SHA256 签名）
- 未设 `ACCESS_PASSWORD` 时免登（开发模式）
- `SESSION_SECRET` 生产环境必须更换默认值
- 预留 `AUTH_MODE = "feishu"` 切换点

### Runtime
- 全部 API 路由标记 `runtime = "nodejs"`（better-sqlite3 不支持 Edge）

## 开发规范

- 按项目现有风格修改。UI 用 globals.css 的 CSS 变量，组件优先复用 `.y-*` class。
- 不做无关格式化，不引入新依赖除非任务明确需要。
- 所有 API 路由必须调 `requireAuth(req)`，前端页面由 `AuthGuard` 守卫。
- 对外部 API 的调用必须用 lib 层的客户端函数，不在页面/路由里直接 fetch SiliconFlow。
- 不吞错 catch，catch 里至少打 logger.error。
- 不确定业务口径时标注"不确定"，不要猜。

## 测试规范

- 纯函数优先测试（cosineSim、rateLimit、auth 签名、自伤检测等）。
- 涉及 SQLite 的测试用 `:memory:` 数据库。
- 不 mock SiliconFlow API（单元测试不调网络）。

## 已知风险与约束

1. **SiliconFlow API Key 是唯一外部依赖**，所有 AI 能力靠它
2. **不引入 ffmpeg**，音频解析走纯 JS
3. **Next.js 15 App Router**，页面组件的 `params` 是 Promise，用 `use(params)` 解包
4. **data/ 目录不入库**，数据库和音频文件需要单独备份（scripts/backup.sh）
5. **CosyVoice 零样本克隆需要参考音频的文字稿**，这是 API 硬性要求
6. **自伤检测是关键词匹配**，不是 NLP，可能漏检/误检
7. **速率限制存内存**，重启清零
8. **对话无流式输出**，用户需等 3-8 秒看到完整回复

## 禁止事项

- 引入 ffmpeg / 重型依赖
- 在页面层堆复杂业务逻辑
- 在 API 路由里直接写 SiliconFlow HTTP 调用（用 lib 封装）
- 改 globals.css 的设计 token 值（颜色/间距/动效已定稿）
- 改数据库 schema 而不更新 tests 和 handoff.md
