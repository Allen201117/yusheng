# 余声 YuSheng — 前端设计规范

> 灵感来源：CSS Design Awards Wellbeing 类目获奖站（Eha Retreat、Diamond Rose Sanctuary、fromanother.love）、Memory Land 悼念应用、Warm Minimalism 设计趋势、Open Design 项目的设计方法论。

---

## 1. 设计理念

**「暖光旧信」**——像在一间午后的老房子里翻出泛黄的信件。

不是冷冰冰的对话框，而是一个**有温度的房间**。用户来这里不是为了"完成任务"，而是为了**和思念的人待一会儿**。每一个交互细节都应该让这个空间感觉更安静、更柔软、更安全。

核心情绪关键词：温暖 / 安静 / 克制 / 亲密 / 安全

---

## 2. 色彩系统

### 2.1 主色调

| Token | 值 | 用途 |
|-------|------|------|
| `--bg` | `#faf6f1` | 页面底色，暖白如旧信纸 |
| `--bg-card` | `#ffffff` | 卡片底色，纯净白 |
| `--bg-input` | `#f5f0ea` | 输入框底色，比页面略深 |
| `--bg-hover` | `#f0ebe4` | 悬停态背景 |
| `--bg-muted` | `#ede7df` | 次级背景、分割区域 |

### 2.2 文字

| Token | 值 | 用途 |
|-------|------|------|
| `--text` | `#3d3229` | 主文字，暖棕黑 |
| `--text-secondary` | `#7a6e62` | 次要文字 |
| `--text-hint` | `#a99d90` | 提示文字、placeholder |
| `--text-accent` | `#8b6e4e` | 强调文字，琥珀棕 |

### 2.3 强调色

| Token | 值 | 用途 |
|-------|------|------|
| `--accent` | `#a07850` | 主操作按钮、关键交互 |
| `accent-hover` | `#8b6a46` | 按钮悬停态 |
| `--accent-soft` | `#a0785012` | 淡化背景、标签底色 |
| `--accent-light` | `#e8ddd0` | 选中态、高亮底色 |

### 2.4 边框与分割

| Token | 值 | 用途 |
|-------|------|------|
| `--border` | `#e4ddd4` | 默认边框 |
| `--border-light` | `#ede7df` | 淡边框、分割线 |
| `--border-focus` | `#a07850` | 输入框聚焦 |

### 2.5 语义色

| Token | 值 | 用途 |
|-------|------|------|
| `--danger` | `#c0503a` | 错误、危险 |
| `--danger-bg` | `#fdf0ed` | 错误背景 |
| `--safe` | `#5a8a5e` | 成功、安全 |
| `--safe-bg` | `#edf5ee` | 成功背景 |

### 2.6 消息气泡

| Token | 值 | 用途 |
|-------|------|------|
| `--bubble-user` | `#a07850` | 用户气泡——琥珀色，像寄出的信 |
| `--bubble-user-text` | `#ffffff` | 用户气泡文字 |
| `--bubble-ai` | `#f5f0ea` | AI 气泡——浅暖灰，像回信的信纸 |
| `--bubble-ai-text` | `#3d3229` | AI 气泡文字 |

---

## 3. 字体

| 角色 | 字体栈 | 大小 / 行高 |
|------|--------|-------------|
| 标题（h1） | `"Noto Serif SC", "Songti SC", Georgia, serif` | 26px / 1.4 |
| 小标题（h2） | 同上 | 18px / 1.5 |
| 正文 / UI | `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif` | 15px / 1.7 |
| 辅助文字 | 同上 | 13px / 1.6 |
| 极小文字 | 同上 | 12px / 1.5 |

标题用衬线体（serif），传达年代感和庄重感；正文用无衬线体（sans-serif），保证可读性。两者搭配，像旧书和新页。

---

## 4. 间距与圆角

### 4.1 间距

| Token | 值 |
|-------|------|
| `--sp-xs` | 4px |
| `--sp-sm` | 8px |
| `--sp-md` | 16px |
| `--sp-lg` | 24px |
| `--sp-xl` | 32px |
| `--sp-2xl` | 48px |

### 4.2 圆角

| Token | 值 | 用途 |
|-------|------|------|
| `--radius-sm` | 8px | 小元素：按钮、标签 |
| `--radius-md` | 12px | 卡片、输入框 |
| `--radius-lg` | 18px | 大气泡、弹窗 |
| `--radius-full` | 9999px | 头像、圆形按钮 |

---

## 5. 阴影

余声的阴影要**柔和而温暖**，像午后的光影。

| Token | 值 | 用途 |
|-------|------|------|
| `--shadow-sm` | `0 1px 3px rgba(60,45,30,0.06)` | 小卡片、输入框 |
| `--shadow-md` | `0 2px 8px rgba(60,45,30,0.08)` | 浮起卡片 |
| `--shadow-lg` | `0 8px 24px rgba(60,45,30,0.10)` | 弹窗、对话框 |

---

## 6. 动效

动效原则：**慢半拍**。不赶时间，像老友慢慢开口。

| 属性 | 值 | 场景 |
|------|------|------|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 出现动画 |
| `--ease-in-out` | `cubic-bezier(0.45, 0, 0.55, 1)` | 状态切换 |
| 快速交互 | 150ms | hover、focus、小状态切换 |
| 中等交互 | 250ms | 卡片展开、面板收起 |
| 慢速交互 | 400ms | 页面过渡、大元素移动 |

### 6.1 具体动效规则

- **按钮 hover**：背景色渐变 150ms + 轻微上移 1px
- **卡片 hover**：阴影加深 250ms + 轻微上移 2px
- **气泡出现**：从下方 8px 渐显 250ms（opacity 0→1 + translateY 8→0）
- **AI 回复打字**：光标闪烁 + 逐字显示（如果将来做流式）
- **页面切换**：无动画，直接渲染（保持安静）

---

## 7. 组件规范

### 7.1 按钮

**主按钮（Primary）**
- 背景 `--accent`，文字白色
- 圆角 `--radius-sm`，padding `10px 24px`
- hover：背景 `--accent-hover` + translateY(-1px) + shadow-sm
- disabled：opacity 0.5，cursor not-allowed

**幽灵按钮（Ghost）**
- 透明背景，`--text-secondary` 文字，`--border` 边框
- hover：背景 `--bg-hover`

**文字按钮（Text）**
- 无背景无边框，`--text-accent` 色
- hover：opacity 0.7

### 7.2 卡片

- 白色背景，`--border` 1px 边框
- 圆角 `--radius-md`，padding `--sp-lg`
- shadow-sm
- hover 态：shadow-md + translateY(-2px)，250ms

### 7.3 输入框

- 背景 `--bg-input`，边框 `--border` 1px
- 聚焦：边框 `--border-focus`，shadow `0 0 0 3px var(--accent-soft)`
- 圆角 `--radius-md`

### 7.4 消息气泡

**用户消息**
- 背景 `--bubble-user`，文字 `--bubble-user-text`
- 圆角：左上 18px、右上 18px、右下 4px、左下 18px（右下角尖）
- 最大宽度 75%

**AI 消息**
- 背景 `--bubble-ai`，文字 `--bubble-ai-text`
- 圆角：左上 18px、右上 18px、右下 18px、左下 4px（左下角尖）
- 最大宽度 75%
- 字体用 serif，像一封手写信

### 7.5 导航栏

- 无独立导航栏，用页面顶部 **返回链接** + **操作按钮** 代替
- 返回链接：左箭头 `←` + 文字，`--text-secondary` 色
- 操作按钮：右侧，ghost 或 text 样式

---

## 8. 页面布局

### 8.1 全局

- 最大宽度 640px，居中
- 左右 padding 20px
- 底部留白 80px（避免被手机底栏遮挡）

### 8.2 页面结构

```
┌─────────────────────┐
│ ← 返回     操作按钮  │  顶栏（flex between）
├─────────────────────┤
│                     │
│    页面标题 + 副标题  │  header 区域
│                     │
├─────────────────────┤
│                     │
│    卡片 / 内容区      │  主体
│                     │
│                     │
└─────────────────────┘
```

### 8.3 对话页特殊布局

```
┌─────────────────────┐
│ ← 首页    管理记忆   │
├─────────────────────┤
│                     │
│  AI 气泡            │  聊天区域（可滚动）
│        用户气泡      │
│  AI 气泡            │
│                     │
├─────────────────────┤
│ [输入框          发送]│  底部固定输入栏
└─────────────────────┘
```

---

## 9. 交互细节

### 9.1 必须实现的交互

1. **按钮 press 态**：active 时 translateY(0)（抵消 hover 的上移），背景色加深
2. **输入框聚焦**：边框变琥珀色 + 外发光圈
3. **气泡出现动画**：新消息从下方 8px 渐显
4. **发送按钮状态**：发送中 → 按钮变为加载态（三个点动画），输入框 disabled
5. **TTS 播放反馈**：播放中，AI 气泡左侧出现呼吸动画的小竖条
6. **卡片 hover 上浮**：列表中的卡片悬停时微微上浮
7. **删除确认**：删除记忆不用 confirm()，用按钮文字切换「删除 → 确认? → 执行」
8. **空状态插图**：没有记忆时显示一句暖心话，不是冷冰冰的"暂无数据"
9. **骨架屏**：列表加载时用浅色色块占位，不用"加载中..."文字

### 9.2 细节打磨

- 所有可点击元素加 `cursor: pointer`
- 禁用态统一 `opacity: 0.5 + cursor: not-allowed`
- 错误提示从上方滑入，不是突然出现
- 长文本自动截断，显示省略号
- 时间戳格式统一：`2024年3月15日`（不用 `2024-03-15`）

---

## 10. 响应式

主要适配 **手机竖屏**（375px–428px），桌面端用 640px 最大宽度自然居中。

| 断点 | 行为 |
|------|------|
| < 480px | 全宽布局，padding 16px |
| 480–768px | 居中，最大宽度 640px |
| > 768px | 居中 640px，两侧留白 |

---

## 11. 设计参考

| 来源 | 借鉴点 |
|------|--------|
| [fromanother.love](https://fromanother.love)（CSSDA WOTD） | 情感化叙事、温暖排版、人与人的连接感 |
| [Eha Retreat](https://www.cssdesignawards.com/sites/eha-retreat)（CSSDA S.Kudos） | 自然色系、呼吸感间距、静谧氛围 |
| [Diamond Rose Sanctuary](https://www.cssdesignawards.com/sites/diamond-rose-sanctuary)（CSSDA S.Kudos） | 疗愈空间、安全感的视觉传达 |
| [Memory Land](https://memoryland.us) | 悼念类应用的共情 UI、克制的交互、记忆容器化 |
| Warm Minimalism 设计趋势 | 少即是多 + 温暖材质感、留白不是空洞而是呼吸 |
| [Open Design](https://github.com/nexu-io/open-design) | 设计规范即代码（design.md → CSS）、skill 驱动的组件系统 |
