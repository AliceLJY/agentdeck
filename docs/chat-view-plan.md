# Chat View + 分栏布局 — 实施计划

> 计划日期：2026-07-05
> 来源：借鉴 jinyu 的 Otter Code App(session 列表 + 渲染对话视图同屏),Alice 确认三项设计决策后开工
> 决策历程：
> - 对话视图形态:三选一(渲染对话视图 / 只修终端滚屏 / 都要)→ 选**渲染对话视图**
> - 分栏设备:三选一(响应式两套 / iPad 为主 / iPhone 为主)→ 选**响应式两套**
> - 附加件:列表实时状态行 ✅ / 新建参数面板 ✅ / meta 行+停止按钮 ✅ / relay 公网中继 ❌(设备都在 Tailscale 网内,不做)
> - 架构:三选一(旁路读 jsonl / Agent SDK 驱动 / 解析终端输出)→ 选**旁路读 jsonl**。
>   SDK 方案否决理由:两套 session 体系、丢真终端、与 TG bridge 定位重复、SDK entrypoint 计费走 credit 不走订阅。
>   终端输出解析否决理由:TUI 是画出来的非结构化,极脆弱。

---

## 目标(验收标准)

1. **对话视图**:运行中的 Claude/Codex session 可切到 Chat 视图——气泡+markdown+工具卡片折叠,顺滑滚屏,自动滚底(用户上翻时暂停并出现「回到最新」按钮)
2. **对话输入**:Chat 视图底部输入框,发送即写入 PTY(与终端打字等价);红色停止按钮随时打断(向 PTY 发 Esc)
3. **分栏布局**:≥768px 常驻窄列表(约 240px,比 Otter Code 的窄一半);<768px 常驻图标条(backend 圆标+状态点),点展开钮弹完整列表
4. **列表实时状态行**:运行中显示当前工具动作(「Bash: git status…」),空闲显示「replied Xm ago + 摘要」
5. **meta 行**:Chat 视图内显示 模型名 · tokens in/out · git branch
6. **新建参数面板**:Claude(model/permission-mode/effort)、Codex(reasoning/sandbox);CLI flag 逐个以 `--help` 验证,不凭记忆
7. **非回归**:终端视图、KeyBar、FileUpload、多设备 taken_over、tmux 恢复全部不变;`npm test` + `npm run build` 通过

## 架构(旁路读,CLI 一字不改)

```
┌─ Browser ──────────────────────────┐   ┌─ Server ─────────────────────────────┐
│ page.tsx                           │   │ server.ts (/ws/terminal 单端口)      │
│ ├─ Rail / Sidebar(响应式)        │   │ ├─ ws-handler(终端协议,现状不动)  │
│ ├─ TerminalView(xterm,现状)    │◄─►│ ├─ TerminalManager(tmux+pty,现状) │
│ ├─ ChatView(新)                 │   │ ├─ TranscriptHub(新)               │
│ │   └─ 独立 WS: chat_attach       │◄─►│ │   ├─ SessionDiscovery(认领 jsonl)│
│ └─ 控制 WS: watch_status          │◄─►│ │   ├─ JsonlWatcher(增量 tail)     │
│                                    │   │ │   └─ transcript-parser(结构化)  │
└────────────────────────────────────┘   └──────────────────────────────────────┘
```

**核心思路**:CC/Codex 自己往磁盘写的 session jsonl(`~/.claude/projects/<dir>/` 与 `~/.codex/sessions/`)就是结构化真相源。终端 session spawn 后,server 按 cwd+mtime 认领对应新文件,增量 tail 并解析成 ChatMessage 推给浏览器。Chat 视图是渲染层;输入走既有 PTY write 通道。

**已知限制(设计时明确)**:CC 弹出的权限确认/选择题等 TUI 交互在 Chat 视图点不了,需切 Term 视图操作(Otter Code 同架构同限制,故保留终端)。

## Session Discovery(认领规则)

- 记录 spawn 时的 `{ backend, cwd, spawnTime, resumeSessionId }`
- Claude:监视 `~/.claude/projects/<projectIdFromCwd(cwd)>/`(映射函数复用 history-index),新出现的 `*.jsonl` 且 mtime ≥ spawnTime−5s → 认领
- Codex:监视 `~/.codex/sessions/` 当日目录,新 `rollout-*.jsonl` → 读文件头 session_meta 校验 cwd 匹配 → 认领
- resume:先尝试按 resumeSessionId 直接命中旧文件,同时继续监视新文件(resume 可能另开新 jsonl,以实测为准)
- 30s 未认领 → state=unclaimed,ChatView 显示提示并引导切终端;之后认领成功可随时升级
- 兜底:fs.watch 不可靠时用 2s 轮询

## WS 协议扩展(全部走现有 /ws/terminal,token 鉴权不变)

Client→Server:
- `chat_attach { sessionId }` / `chat_detach {}` — 订阅某 session 的对话流；同一 WS 同时取得 / 释放终端 attachment，必要时触发 takeover
- `watch_status {}` — 订阅全部 session 状态(sidebar 用)
- `chat_input { sessionId, text }` — server 侧包装成 bracketed-paste + 回车写 PTY；两次写入都按当前 WebSocket attachment 校验 owner
- `interrupt { sessionId }` — owner 校验通过后写 `\x1b`(Esc)打断

Server→Client:
- `chat_init { sessionId, state, messages, meta }` — attach 时全量(大 session 只发最近 200 条)
- `chat_event { sessionId, messages }` — 增量(可批量)
- `chat_state { sessionId, state }` — pending/claimed/unclaimed 变化
- `status_all { statuses }` — 状态订阅的初始快照+节流推送(约 1s)

## 数据类型(lib/types.ts 扩展)

```ts
interface ChatMessage {
  id: string; role: 'user' | 'assistant';
  text: string;              // markdown 原文,保留换行(不做 normalize)
  tools: ToolCallInfo[];     // 本消息内的工具调用
  timestamp: string; model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
interface ToolCallInfo { id: string; name: string; summary: string }
interface SessionStatus {
  sessionId: string; state: 'working' | 'idle' | 'unknown';
  currentAction?: string; lastReplyAt?: string; lastReplyPreview?: string;
  model?: string; totalIn?: number; totalOut?: number; gitBranch?: string;
}
```

working 判定:jsonl 最近 10s 内有新事件 = working(取最后一个 tool_use 做 currentAction);静默即 idle(取最后 assistant 文本做 preview)。

## 解析要点(lib/transcript-parser.ts,新文件;history-index 现有解析不动)

Claude 行:
- `type:'assistant'` → text block 合并(保留换行)、tool_use → ToolCallInfo(input 摘要取 command/file_path/pattern/prompt 等常见字段前 80 字)、thinking 跳过;`message.model`/`message.usage` 进 meta;按 `message.id` 聚合同一 turn 的多行
- `type:'user'` → text 进消息;tool_result 不单独成消息;isMeta、`<command-`、`<local-command-` 开头的注入内容跳过
- 其余 type(progress/summary/file-history-snapshot…)防御性跳过

Codex 行:
- `session_meta` → cwd/sessionId;`response_item` payload.type='message' → 消息(复用 isCodexInjectedContext 过滤);`function_call` → ToolCallInfo;reasoning/event_msg 跳过(token_count 若存在则进 usage,以真实文件为准)

## UI 要点

- **ChatView**:用户消息右侧浅色气泡;assistant 左侧无框文段;markdown 用 react-markdown + remark-gfm(新依赖);工具调用聚合成折叠条「N tools · Bash ×3 · Edit ×2」点开逐条列表;meta 行贴在消息区底部;输入框 textarea 自适应 1–6 行
- **Chat|Term 切换**:顶栏分段控件;默认认领成功进 Chat、否则 Term;记住每 session 上次选择(localStorage);KeyBar 只在 Term 视图显示
- **分栏**:md+ 时 Sidebar 从 fixed overlay 变常驻列(w-[240px]);<md 常驻 rail(w-12,展开钮+每 session 圆标+状态点+新建钮),完整列表仍走现有 overlay 抽屉
- **SessionItem 状态行**:第二行替换纯时间戳——working 时绿色斜体动作摘要+呼吸点;idle 时「replied Xm ago · 摘要」

## 实施阶段(每阶段独立 commit)

1. **Phase 1**:transcript-parser + session-discovery(带 node --test 单测)→ TranscriptHub + WS 协议 → ChatView 只读 + Chat/Term 切换
2. **Phase 2**:响应式分栏 + Chat 输入框/停止按钮
3. **Phase 3**:SessionItem 状态行 + meta 行 + 新建参数面板(flag 以 `claude --help`/`codex --help` 实测为准)

## 风险与对策

- jsonl 格式演进 → 未知 type/字段一律跳过,解析永不 throw
- 13MB 级大 session → chat_init 截断到最近 200 条;JsonlWatcher 从认领时的文件尾开始增量,历史部分一次性读
- macOS fs.watch 抖动 → 轮询兜底
- 双输入并发(终端+Chat 同时打字)→ 等价于两人对一个终端打字,TUI 自行处理,不做互斥
