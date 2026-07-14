# CLAUDE.md

本文件约束所有继续开发余声的 agent。产品已经部署，但仍处于 0→1 验证和生产加固阶段。

## 核心目标

余声是“经授权的声音记忆陪伴产品”。核心价值是：用真实授权的声音材料、人物事实与关系记忆，生成低延迟、有情绪但不冒充本人真实意志的语音对话。不要把产品描述成“复活逝者”。

当前不做视觉重构。需要优先保证：数据不丢、用户隔离、声音授权与删除、声音相似度和情绪、首音速度、人物事实一致性。

## 技术栈

- Next.js 15 App Router、React 18、TypeScript、Node.js >= 22
- 生产结构化数据：Neon Serverless Postgres + pgvector
- 生产声音原文件：Vercel Private Blob
- 本地开发和旧数据迁移：better-sqlite3 + `data/voices`
- AI 服务：SiliconFlow ASR / bge-m3 / DeepSeek-V3 / CosyVoice

## 常用命令

```bash
npm install
npm run dev
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run db:migrate:dry
npm run db:migrate
npm run data:migrate:dry -- --data-dir ./data
```

## 存储边界

- API 路由不得直接 import `@/lib/db` 或 `@/lib/voiceStore`。
- 结构化数据只能通过 `src/lib/storage/repository.ts`。
- 声音原文件只能通过 `src/lib/storage/voiceObjectStore.ts`。
- 生产必须设置 `STORAGE_BACKEND=cloud`、`DATABASE_URL` 和 `BLOB_READ_WRITE_TOKEN`。
- 生产拒绝 `STORAGE_BACKEND=local`，不得回退到 Vercel 临时文件系统。
- 所有用户资源读取必须带 owner ID；人物的记忆和消息通过已验证的人物归属访问。

## 人物知识真相边界

- 人物知识分为三层：结构化事实、关系记忆、说话风格；对话检索只能读取 `confirmed` 状态的内容。
- 用户通过 `/api/memory` 手工录入，等同于用户明确确认；AI 提取的候选内容必须保持 `pending`，不能直接进入对话。
- 旧版 `memories` 会幂等复制为来源、关系记忆和证据关联；本阶段不删除旧表。
- 删除知识来源时，没有其他 `ready` 来源支撑的派生内容必须立即撤销，并返回受影响内容的类型和 ID。
- 事实需要证据；表达方式可以模仿，但生成内容不得被表述为声音主人的真实意志。

## 目录重点

```text
src/app/api/                         已鉴权的业务入口
src/lib/storage/config.ts            存储配置和生产保护
src/lib/storage/repository.ts        本地/云结构化存储边界
src/lib/storage/postgresRepository.ts Neon repository
src/lib/storage/voiceObjectStore.ts  本地/Private Blob 边界
migrations/                          版本化 Postgres schema
scripts/apply-migrations.ts          schema migration
scripts/migrate-local-data.ts        旧数据 dry-run / import / report
tests/                               Node test runner 测试
docs/handoff.md                      上线与交接契约
```

## 开发规范

1. 先写能失败的测试，再实现；修复后跑相关测试、全量测试、类型检查和构建。
2. API 必须先 `requireAuth(req)`；不得新开免鉴权的数据入口。
3. 外部 AI API 只通过 `src/lib` 客户端调用，不在页面或路由散落请求。
4. 新 schema 必须增加版本化 migration，同时更新 repository、测试和 `docs/handoff.md`。
5. 不吞错误；日志不得包含密钥、完整声音字节、密码或验证码。
6. 不把 `data/`、真实音频、`.env*` 或 `migration-report.json` 提交到 Git。
7. 不改视觉设计，除非用户明确重新授权。

## 当前事实与风险

- `/api/chat` 已按完整句子输出语音事件，客户端并发准备且按序播放；真实首音延迟尚未验收。
- TTS 入口会去掉“（轻声）”类开头舞台说明；直接本人/复活身份问题由服务端返回固定 AI 披露，不交给模型自由生成。
- 预置音色 ready 时 TTS 不下载 Blob；URI 失效可一次回退动态克隆。权利确认未落库前不得自动批量预置。
- 声音授权已有独立记录和撤回状态；只有“健在 + 本人 + 三项单独确认”会自动 approved，健在亲友与逝者均进入 `pending_review`。
- TTS 始终拒绝 `revoked`；`VOICE_AUTH_ENFORCEMENT=enabled` 时还会拒绝缺失或待审核授权。功能客户端未接通前不得在 Production 开启。
- 认证默认为邮箱密码；只有显式 `AUTH_MODE=disabled` 才免登。
- `SESSION_SECRET` 在生产不能使用默认值或空值。
- TTS 限流仍在单进程内存里，多实例不可靠。
- 自伤检测仍是关键词规则。
- 真实 Preview 持久化、跨用户隔离、Blob 删除和重部署后的读回必须有直接证据，不能用本地测试代替。
- Vercel Sensitive 变量在 `env pull` 中会被脱敏为空，不能据此判断缺少 Key。Preview `SILICONFLOW_API_KEY` 已重新写入为 Sensitive；是否可用必须由新 deployment 的真实请求证明。
- 授权依据、告知版本和撤回已落库；健在第三人的证据核验、逝者场景人工审核、删除完成凭证与用户可见的 AI 合成标识仍未完成。
- grounded/陪伴对话模式、消息级证据、还原度反馈指标和真实用户验证仍未完成。

## 禁止事项

- 线上使用 SQLite、`data/voices` 或公开 Blob
- 只凭 personaId / voiceId 读取资源，不核对 userId
- 在迁移报告有 `missing` / `failed` 时切 Production
- 假装“本地构建成功”等于“线上持久化已验证”
- 引入 ffmpeg 作为必需依赖
- 未经用户要求进行视觉层重构
