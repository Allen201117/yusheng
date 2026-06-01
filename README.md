# 余声 v2

余声是一个 AI 声音记忆陪伴 MVP。用户上传或录制一段参考声音，创建人物，录入记忆片段，然后用文字对话，并听到克隆声音朗读回复。

当前版本的目标不是做完整社交产品，而是把最小但真实的闭环做稳：

```text
录参考声音 -> 创建人物 -> 录入记忆 -> RAG 对话 -> 克隆声音朗读
```

## 当前能力

- 邮箱 + 密码登录，首次登录自动注册
- 用户级数据隔离：人物、记忆、消息、参考声音均按 `userId` 访问
- 浏览器录音或上传音频，支持 wav/mp3/m4a/webm
- 参考音频自动 ASR，文字稿也可手动修正
- SQLite 存储人物、记忆、消息；参考声音保存在本地 `data/voices`
- bge-m3 向量化记忆，对话时按相似度召回
- DeepSeek-V3 流式回复
- CosyVoice2 零样本声音克隆朗读
- TTS 每用户每日限流
- 自伤关键词兜底回复
- 暖光旧信风格 UI

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
```

至少填写：

```bash
SILICONFLOW_API_KEY=sk-xxx
SESSION_SECRET=请换成足够长的随机字符串
AUTH_MODE=email
```

开发时如果需要跳过登录，可以显式设置：

```bash
AUTH_MODE=disabled
```

生产环境不要使用 `AUTH_MODE=disabled`，也不要使用 `.env.example` 里的默认 `SESSION_SECRET`。

### 3. 启动

```bash
npm run dev
```

打开 http://localhost:3000

## 验收流程

1. 注册或登录一个邮箱账号。
2. 进入「录声音」，录制或上传 10 秒到 5 分钟的清晰人声音频。
3. 自动识别文字稿，必要时手动修正。
4. 创建人物，填写姓名、关系、性格和说话方式。
5. 每行录入一条具体记忆。
6. 进入对话页发送消息，检查是否流式回复，并能用参考声音朗读。

## 技术结构

```text
src/app
  api/auth/*              登录、登出、验证码、重置密码
  api/voice/*             参考声音上传、ASR
  api/persona             人物 CRUD
  api/memory              记忆 CRUD
  api/chat                RAG + LLM 流式对话
  api/tts                 CosyVoice 语音合成
  persona/*               创建、记忆、聊天页面
  voice/new               录音/上传页面

src/lib
  auth.ts                 session 签名与认证模式
  db.ts                   SQLite 数据层
  voiceStore.ts           用户级声音文件存储
  asr.ts                  SiliconFlow ASR
  embedding.ts            SiliconFlow embedding
  llm.ts                  SiliconFlow chat completion
  cosyvoice.ts            SiliconFlow CosyVoice
  rateLimit.ts            TTS 限流
```

运行时数据默认写入 `data/`，该目录已被 git 忽略。

## 常用命令

```bash
npm run dev
npm run build
npm run lint
npm test
```

`npm run lint` 当前是非交互式 TypeScript 检查，避免 Next.js 在无 ESLint 配置时进入初始化向导。

## 仍需注意

- 参考声音仍在本地磁盘，部署迁移和多实例需要对象存储或备份方案。
- 自伤检测只是关键词兜底，不等于完整安全系统。
- Resend 未配置时，验证码会打印到服务端终端，仅适合本地调试。
- SiliconFlow 是唯一外部 AI 依赖，所有 ASR/Embedding/LLM/TTS 都依赖同一个 API Key。
