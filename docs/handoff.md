# 余声交接文档

> 最后更新：2026-07-15
> 当前阶段：已上线产品的生产底座加固；云存储切换尚需真实 Preview 验证

## 产品定位

余声是“经授权的声音记忆陪伴产品”：保存本人或亲友的声音与真实记忆，通过低延迟、有情绪的语音对话让用户重新听见熟悉的表达。健在者和逝者需要走不同授权流程；产品不得暗示“复活”或把模型生成内容冒充本人的真实意志。

当前核心流程：

```text
登录 -> 上传或录制参考声音 -> 创建人物 -> 录入记忆 -> 流式文字对话 -> 克隆声音朗读
```

授权策略的规则依据是《个人信息保护法》对生物识别敏感信息和单独同意的要求，以及《互联网信息服务深度合成管理规定》对人声编辑告知、单独同意和合成标识的要求。这些后端控制不等于已完成法律合规审查。

## 当前生产架构

| 数据 | 本地开发 | Vercel Production / Preview |
|---|---|---|
| 用户、人物、记忆、消息、声音元数据 | SQLite | Neon Serverless Postgres |
| 参考声音原文件 | `data/voices` | Vercel Private Blob |
| 向量 | SQLite BLOB | pgvector `vector(1024)` |

所有 API 只能通过 `src/lib/storage/repository.ts` 和 `src/lib/storage/voiceObjectStore.ts` 读写数据。SQLite 与 `data/voices` 只允许用于本地开发和旧数据迁移，不能作为线上持久化方案。

## 人物知识与证据边界

- 人物知识已拆为结构化事实、关系记忆、说话风格三层；只有 `confirmed` 内容能被对话检索。
- 用户手工调用 `/api/memory` 录入的内容视为明确确认；AI 后续提取的候选内容只能先进入 `pending`，必须经用户确认。
- 旧版 `memories` 会幂等复制成来源、关系记忆和证据关联。旧表本阶段保留，便于回查和回滚，不能提前删除。
- 删除来源会立刻撤销所有已没有其他 `ready` 来源支撑的派生内容，并返回受影响内容的类型和 ID，供调用方审计。
- 对话只能使用 confirmed 事实/关系记忆作为 evidence；confirmed 说话风格单独注入提示词，不能证明人物事实。

## Grounded 对话运行边界

- 有可靠 evidence 时走 `grounded`；没有相关证据时走 `companionship` + `no_relevant_evidence`；知识读取、向量或证据绑定失败时走 `companionship` + `retrieval_failed`。陪伴模式不带人物事实或关系记忆。
- 每条完成的 `grounded` 助手消息会复制本轮选中的 evidence ID 到消息证据表。之后来源被撤销也不删这份生成时快照。
- 未知遗愿、代表承诺、重大决策、本人/复活/另一个世界、自伤、现实暴力或医疗急症、声音未获有效授权，都走固定 `boundary` 回复。这些路径不调用自由生成模型，也不输出可交给 TTS 的 sentence 事件。
- 对话历史只是临时上下文，不是 evidence；用户本轮的主张也不能变成 evidence。
- 确定性行为探针和播放队列失败隔离已纳入本地回归。对同一 persona 的句子做外部重试时，会重新通过该 persona 解析它自己的 voice/source；A/B 双 persona fixture 证明 A 的两次尝试都没有访问或使用 B 的声音。`npm run probe:grounded` 另外调用真实模型验证虚构样本，JSON 报告不包含 API key 或请求 headers。
- 真实模型探针只把已完成模型回复的内容断言失败记为 `red_line_failed` (exit 1)。未配置 provider 是 `provider_not_configured` (exit 2)；网络、HTTP/401/429/5xx、超时和响应解析异常都是 `provider_failed` (exit 3)。每个 case 最多调用模型一次，超时会通过 AbortSignal 取消正在进行的 fetch。

生产环境必须同时配置：

```dotenv
STORAGE_BACKEND=cloud
DATABASE_URL=...
BLOB_READ_WRITE_TOKEN=...
SILICONFLOW_API_KEY=...
SESSION_SECRET=...
AUTH_MODE=email
VOICE_AUTH_ENFORCEMENT=disabled
```

缺少云配置或在生产设置 `STORAGE_BACKEND=local` 时，存储初始化必须报错，不能静默创建 `./data`。

## 关键代码

```text
migrations/001_production_foundation.sql  Postgres / pgvector schema
migrations/002_provider_voice_lifecycle.sql 供应商音色状态机
scripts/apply-migrations.ts               幂等 schema migration
scripts/migrate-local-data.ts             SQLite + 本地声音盘点和迁移
scripts/report-restoration-feedback.ts    只输出健在/逝者聚合指标的运营命令
src/lib/storage/config.ts                 生产存储强制保护
src/lib/storage/repository.ts             本地/云 repository 选择
src/lib/storage/postgresRepository.ts     Neon 数据访问
src/lib/storage/voiceObjectStore.ts       本地文件/Private Blob 选择
src/lib/voicePresetService.ts             预置音色创建与删除生命周期
src/lib/voiceSynthesisService.ts          预置音色快路径与一次动态回退
src/lib/voiceAuthorizationPolicy.ts       授权决策与 TTS 门禁
src/app/api/voice/authorization           授权查询、提交与撤回
src/app/api/*                             只调用上述异步边界
```

## 上线切换顺序

不要直接把 Production 切到 cloud。按以下顺序执行：

1. 在 Vercel 项目中连接独立的 Preview Neon 数据库和 Private Blob。
2. 只给 Preview 设置 `STORAGE_BACKEND=cloud`、`DATABASE_URL`、`BLOB_READ_WRITE_TOKEN`。
3. 执行两次 `npm run db:migrate`；第一次只应用待执行版本，第二次必须显示零新增。
4. 对真实旧数据执行 dry-run：

   ```bash
   npm run data:migrate:dry -- --data-dir ./data --report ./migration-report.json
   ```

5. 检查报告中的每个 `missing` 和 `failed`。旧声音没有 `userId` 时，工具会尝试按引用它的唯一人物所有者归属；多个用户共同引用时必须用 `--user-map` 人工确认。
6. 执行正式迁移：

   ```bash
   STORAGE_BACKEND=cloud npm run data:migrate -- \
     --data-dir ./data \
     --user-map ./user-map.json \
     --report ./migration-report.json
   ```

7. 重新执行正式迁移。相同 ID 和相同用户下的声音校验和必须全部变为 `skipped`，不能重复导入。
8. 部署 Preview，使用两个测试账户验证：A 上传的声音，B 无法列出、读取、绑定或删除；重新部署后 A 的人物、记忆、消息和声音仍存在。
9. 删除测试声音，确认 Blob 已不存在，Postgres 元数据已软删除，TTS 不再可用。
10. 保存不含密钥的证据到 `docs/verification/production-foundation.md`，再决定是否切 Production。

## 本地验证

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run --silent report:restoration
git diff --check
```

生产保护的直接验证：

```bash
NODE_ENV=production STORAGE_BACKEND=local \
  node --import tsx -e 'import("./src/lib/storage/repository.ts").then(m => (m.getRepository || m.default.getRepository)())'
```

预期报错：`Production requires STORAGE_BACKEND=cloud`。

## 已知但尚未完成的高风险项

- 真实 Preview 的 Neon / Private Blob 读写、跨用户隔离、重部署持久化和删除还没有形成证据前，不能宣称生产底座完成。
- 当前 Preview 仍不可用：必须先由 Neon 提供 `DATABASE_URL`，并在 Preview 设置 `STORAGE_BACKEND=cloud`，之后才能继续真实持久化门禁。
- TTS 限流仍是进程内 Map，多实例会失真；应迁移到持久化计数或托管限流。
- 句级 SSE 和有序播放队列已实现，但真实 Preview 的首音延迟、20 轮稳定性和 4 秒目标仍未验收。
- 本地真实模型行为探针已记录在 `docs/verification/persona-behavior-baseline.md`；舞台说明从 9/10 降为 0/10，本人/复活问题已改为固定 AI 披露。20 次模型请求的首句延迟 P50 1.852s、P95 4.083s、最慢 7.484s，所以 4 秒目标尚未稳定达成。这不等于真实音频和 20 轮用户验收。
- Vercel Sensitive 变量通过 `env pull` 时会被脱敏为空，不能用拉取文件判定 Key 是否存在。Preview `SILICONFLOW_API_KEY` 已从项目本地秘密重新写入为 Sensitive；Production 没有改动。两者是否可用都必须由真实 deployment 请求证明。
- 供应商预置音色状态机、TTS 快路径、失效 URI 的一次动态回退和可重试删除已有代码；只有当前 `approved` 授权可触发预置音色。
- 授权记录、撤回和受控预置 API 已有后端；只有健在本人会自动 approved，亲友与逝者均待人工审核。已有授权记录一旦为 pending/revoked 就禁止 TTS；开关关闭时只兼容“完全没有授权记录”的旧声音。当前没有功能客户端，Production 不得设置 `VOICE_AUTH_ENFORCEMENT=enabled`。
- SiliconFlow 用户预置音色需供应商账号完成实名认证；当前尚无真实成功证据。
- 健在第三人授权证据核验、逝者场景人工审核、删除完成凭证和用户可见的 AI 合成标识仍未完成。
- 三层人物知识、confirmed-only 检索、grounded/companionship/boundary 路由、消息级 evidence、非视觉浏览器播放 telemetry、评分资格和健在/逝者聚合报告已本地落地。`play_started` 只证明客户端报告开始播放，TTS 成功不等于已播放/已听完。真实 Preview 浏览器 + provider + DB readback、有效还原真实用户样本和 AI 候选提取仍未完成。详见 `docs/verification/restoration-feedback.md`。
- 真实模型虚构数据探针与确定性单测分开记录，两者都不能替代认识声音主人的人评价“是不是像”。
- 本地测试、类型检查和构建通过只证明当前代码库门禁，不授权推送、Preview 或 Production 发布。
- 自伤检测仍是关键词规则，不能当作完整安全系统。

## 不得破坏的约束

1. 所有业务 API 先执行 `requireAuth()`，再访问用户数据。
2. 人物、声音查询必须带 `userId`；不得只凭可枚举 ID 返回数据。
3. 参考声音必须使用 Private Blob；不得生成公开 Blob URL。
4. 创建人物前必须确认 voice 属于当前用户。
5. 删除人物后，只有该用户没有其他人物复用声音时才删除原文件；供应商删除失败必须返回 `cleanupPending`，并可通过已鉴权的 `DELETE /api/voice/upload?id=...` 重试。
6. `AUTH_MODE=disabled` 只允许本地演示与测试。
7. 不把密钥、迁移报告或真实声音样本提交到 Git。
8. 不引入 ffmpeg 作为必需运行时依赖。
