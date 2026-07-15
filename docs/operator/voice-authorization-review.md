# 声音授权人工审核操作手册

本命令只给受控运维人员使用，不是公开管理接口。代码库没有新增 admin HTTP route。

## 运行前必须确认

命令会直接写入当前环境配置指向的数据库，并可能读写当前对象存储、创建或删除供应商预置音色。实际运行前必须取得明确操作授权，并确认 `STORAGE_BACKEND`、数据库、Blob 和供应商配置确实指向预期环境。不要把密钥、原始供应商错误或真实声音内容粘贴进审核理由。

审核人必须先在线下核对申请人、声音主人、授权依据和证明材料。系统不会自动批准健在第三人或逝者声音；CLI 也不会替代法律或合规判断。

同一个 voice 第一次提交后的“健在/已故”和授权依据会锁定，pending 不能改口为 living/self 绕过审核；并发提交也由数据库事务内复查阻断。若用户首次选错，需要按受控纠错流程处理或重新上传声音，不能让用户端直接覆盖人工审核轨迹。

## 命令

```bash
npm run --silent voice-auth:review -- \
  --authorization-id AUTHORIZATION_ID \
  --decision approve \
  --reviewer-id OPERATOR_ID \
  --reason evidence_verified \
  --confirm
```

拒绝时把 `approve` 改成 `reject`，并填写稳定、可审计的理由。五项参数全部必填，`--confirm` 是防误操作确认。命令只允许把 `pending_review` 原子更新为 `approved` 或 `rejected`；不存在、重复审核和终态记录都会稳定拒绝。

输出只有一个 JSON 对象：

- 批准成功：`status=approved`，同时返回 `presetStatus`。如果供应商创建失败，授权仍是 approved，`presetStatus=failed`；TTS 仍必须通过 approved 门禁，之后可走受控重试。
- 拒绝成功：`status=rejected`，不会创建音色，并清理已有预置音色。`cleanupPending=true` 表示数据库拒绝已生效，但供应商清理需要重试；用户声音页会显示“重试清理音色”，清理不会把 rejected 审核改写为 revoked。不要重复执行审核命令冒充第二次审核。
- 安全失败：`ok=false` 和稳定 `errorCode`，不会输出数据库连接、供应商原始错误或密钥。

## 运行边界

本轮只实现和本地验证命令，不执行任何真实审核，不连接真实供应商，不修改 Preview 或 Production。进入 2+2 干跑前，必须先做 1 名健在者 + 1 名逝者的 1+1 彩排，并人工核对数据库审计字段、供应商状态和撤回后的门禁。
