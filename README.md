# 余声 v2

> 从 0 重做。第一性原则：先证明它能让人哭，再证明它好看。

## 当前阶段：Slice 1 — 听到那个声音

**目标**：上传一段参考音频 → 输入想说的文字 → 听到克隆声朗读出来。

其它一律不做：
- 没有登录、没有数据库、没有对话、没有记忆
- UI 黑底白字，原生组件，禁止美化
- 验收标准：你上传你自己的 30 秒声音，输入"今天天气真好"，浏览器播放出来你能听出是你

跑通这一步，Slice 1 就算结束。

---

## 路线图

| 切片 | 周次 | 目标 |
|---|---|---|
| Slice 1 | W1 | 声音克隆端到端跑通（CosyVoice API） |
| Slice 2 | W2 | SQLite + 向量检索的记忆系统 + 对话 |
| Slice 3 | W3 | 飞书 OAuth + 用户隔离 + 上传白名单 + 限流 |
| Slice 4 | W4 | 备份、监控、自伤词检测；**此时才允许动 UI** |

---

## 快速开始

### 1. 拿一个 SiliconFlow API Key

打开 https://cloud.siliconflow.cn/account/ak 申请，复制 Key。

### 2. 配置环境变量

```bash
cp .env.example .env.local
# 编辑 .env.local，把 SILICONFLOW_API_KEY 填上
```

### 3. 安装依赖并启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000

### 4. 验收 Slice 1

1. 录一段你自己的声音 30 秒（手机录音 → 转 wav 或 mp3）
2. 在页面上传，并准确填写"音频里说了什么"（这一步不能糊弄，CosyVoice 要靠这个文字稿对齐音色）
3. 在第 3 段输入"今天天气真好"，点"生成并播放"
4. 听到的声音如果能被你识别为"是这个人"，✅ Slice 1 通过

---

## 目录结构

```
yusheng-v2/
├── docs/                          # 产品方案 PDF（保留）
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx               # Slice 1 唯一页面
│   │   └── api/
│   │       ├── voice/upload/route.ts   # 上传参考音频
│   │       └── tts/route.ts            # 调 CosyVoice 合成
│   └── lib/
│       ├── voiceStore.ts          # 文件系统存储（Slice 1 不用 DB）
│       └── cosyvoice.ts           # SiliconFlow CosyVoice 客户端
├── data/                          # 运行时数据（git 忽略）
│   └── voices/
│       ├── {uuid}.wav
│       └── {uuid}.meta.json
├── .env.example
└── package.json
```

---

## 为什么这次不一样

回看 v1 失败原因：12 套 UI 主题（3,438 行）+ 假的声音克隆（降级到浏览器朗读）+ JSON 文件当 DB + `String.includes` 当向量检索。**精力都花在皮肤上，核心能力是空壳。**

v2 规则：
1. **垂直切片，不分层**。每个切片必须端到端真的能用
2. **核心差异化能力优先**：声音克隆 > 记忆 > 鉴权 > 美化
3. **UI 冻结到 Slice 4**。在那之前任何改 UI 的冲动写到 `docs/style-backlog.md`，不允许提交

---

## 文档

- `docs/「余声」— AI 声音记忆陪伴机器人产品方案.pdf` — 原始产品方案 v0.1
- `docs/余声_prd_v0_2.pdf` — PRD v0.2
- `docs/cosyvoice-notes.md` — SiliconFlow CosyVoice 接入笔记
