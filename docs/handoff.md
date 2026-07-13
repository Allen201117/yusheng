# 余声交接文档

> 最后更新：2026-07-13
> 当前阶段：已上线产品的生产底座加固；云存储切换尚需真实 Preview 验证

## 产品定位

余声是“经授权的声音记忆陪伴产品”：保存本人或亲友的声音与真实记忆，通过低延迟、有情绪的语音对话让用户重新听见熟悉的表达。健在者和逝者需要走不同授权流程；产品不得暗示“复活”或把模型生成内容冒充本人的真实意志。

当前核心流程：

```text
登录 -> 上传或录制参考声音 -> 创建人物 -> 录入记忆 -> 流式文字对话 -> 克隆声音朗读
```

## 当前生产架构

| 数据 | 本地开发 | Vercel Production / Preview |
|---|---|---|
| 用户、人物、记忆、消息、声音元数据 | SQLite | Neon Serverless Postgres |
| 参考声音原文件 | `data/voices` | Vercel Private Blob |
| 向量 | SQLite BLOB | pgvector `vector(1024)` |

所有 API 只能通过 `src/lib/storage/repository.ts` 和 `src/lib/storage/voiceObjectStore.ts` 读写数据。SQLite 与 `data/voices` 只允许用于本地开发和旧数据迁移，不能作为线上持久化方案。

生产环境必须同时配置：

```dotenv
STORAGE_BACKEND=cloud
DATABASE_URL=...
BLOB_READ_WRITE_TOKEN=...
SILICONFLOW_API_KEY=...
SESSION_SECRET=...
AUTH_MODE=email
```

缺少云配置或在生产设置 `STORAGE_BACKEND=local` 时，存储初始化必须报错，不能静默创建 `./data`。

## 关键代码

```text
migrations/001_production_foundation.sql  Postgres / pgvector schema
migrations/002_provider_voice_lifecycle.sql 供应商音色状态机
scripts/apply-migrations.ts               幂等 schema migration
scripts/migrate-local-data.ts             SQLite + 本地声音盘点和迁移
src/lib/storage/config.ts                 生产存储强制保护
src/lib/storage/repository.ts             本地/云 repository 选择
src/lib/storage/postgresRepository.ts     Neon 数据访问
src/lib/storage/voiceObjectStore.ts       本地文件/Private Blob 选择
src/lib/voicePresetService.ts             预置音色创建与删除生命周期
src/lib/voiceSynthesisService.ts          预置音色快路径与一次动态回退
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
- TTS 限流仍是进程内 Map，多实例会失真；应迁移到持久化计数或托管限流。
- 句级 SSE 和有序播放队列已实现，但真实 Preview 的首音延迟、20 轮稳定性和 4 秒目标仍未验收。
- 供应商预置音色状态机、TTS 快路径、失效 URI 的一次动态回退和可重试删除已有代码；在权利确认记录完成前不得对已有声音自动批量预置。
- SiliconFlow 用户预置音色需供应商账号完成实名认证；当前尚无真实成功证据。
- 授权、撤销、彻底删除、逝者场景的权利证明仍需单独实现。
- 人物设定和记忆仍偏自由文本，需要结构化事实、说话风格和不确定性边界。
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
