# AgentDeck

给 AI 编程 CLI 用的 Web 远程终端——[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、[Kimi Code](https://moonshotai.github.io/kimi-code/)，一个标签页一个。手机、平板、电脑，任何设备都能通过浏览器连上。

**架构上能装任何 agent CLI，不只这两个。** 这里的一个 backend，无非是「一条 CLI 路径
+ 它的 argv 规则」——怎么启动、怎么 resume、哪些 flag 是安全的（`lib/backends.ts`）。
这层之上的东西（PTY、tmux 持久化、标签栏、对话视图、历史浏览）全都与具体 agent 无关，
所以让它认识一个新 CLI 是在那个文件里加一条，不用动传输层——Kimi 就是这么进来的。

**是真终端，不是阉割版聊天框。** xterm.js + node-pty + tmux 完整还原 Claude Code 和 Codex 在终端里的体验——颜色、光标、滚动、链接，一个不少。在这之上再叠一层**可选的对话视图**：同一个 live session 渲染成干净、能滚的消息气泡，手机上读长回复、打字都顺手，底下那个真终端一点没丢。

[English README](./README.md)

![AgentDeck](docs/screenshot.png)

*三个 CLI 并排——顶上是 Kimi、Claude Code、Codex 的标签，侧边栏是聊过的对话。
截图里的 session 标题和项目名都是占位示例。*

## 功能

- **三个 backend，一个 UI** — 同一个浏览器里能开 Claude Code、Codex、Kimi Code；每个 session 用颜色区分 backend（Claude 蓝、Codex 绿、Kimi 紫）
- **历史浏览** — 跨 backend 的 history view：按当前 backend / 项目筛选展示最近活跃的最多 25 个 session；搜索只过滤这批已加载结果（暂时没有翻页），列表里的 session 可以点一下 resume
- **真终端** — xterm.js 渲染完整终端体验，不是 Markdown 聊天框
- **对话视图** — 任意 live session 一键翻成结构化对话：消息气泡、Markdown 渲染、可折叠的工具调用条、自动滚底（往上翻就暂停）。它读的是 CLI 自己写的 transcript 文件，所以拿到的是完整、能滚的记录——终端取景框会把长回复裁掉半截，对话视图不会。要点 TUI 选择框 / 权限确认，一键切回真终端。
- **对话里直接发 & 打断** — 直接从对话视图打字发送（写进 PTY，跟在终端里敲一样）；停止按钮随时打断正在跑的 agent。还能内联传图 / 文件——发一张手机截图，agent 直接读。
- **顶部标签栏** — 开着的 session 像浏览器标签一样横在最上面，每个带 backend 徽章，agent 干活时状态点会呼吸。并排跑的 Claude 和 Codex 一眼就能分清，手机上也一样。
- **侧边栏是聊过的对话** — 标签栏后面那栏列出所有 backend 最近的 20 段对话，点一下直接 resume。带绿点表示已经有 live session 在写那份 transcript，点它会跳进正在跑的那个 session，不会 fork 出第二份。
- **实时状态** — session 会显示它此刻在干什么（运行中显示当前工具调用），空闲时显示上一条回复摘要。
- **新建参数面板** — 开 session 前选模型、reasoning 力度、权限模式（Claude）或 reasoning / sandbox（Codex）；每个值都对着 CLI 自己的 flag 校验过。
- **多 Session** — 点 "+" 最多开 10 个并发终端，自由切换，互不干扰
- **tmux 持久化** — Session 撑过服务端重启；PTY 跑在 tmux 里，WebSocket 只是 attach 上去
- **5MB 环形缓冲** — 每个 Session 保留 5MB 输出历史，attach / 重连时 replay，跨设备切换不丢上下文
- **文件上传** — 拖拽到终端区域，或在两个视图里点回形针，把文件交给正在跑的 agent
- **三端通用** — iPhone、iPad、安卓、电脑浏览器，通过 Tailscale 随时访问
- **iPad / iOS 友好** — 触摸快捷键栏（Esc、Tab、Ctrl+C、方向键）+ iOS 26 IME 输入修复
- **深色/浅色主题** — 跟随系统，侧边栏可切换
- **Token 认证** — token 不会写入页面 HTML；通过 `?token=` 链接或登录框提供，浏览器会记住
- **单端口** — HTTP + WebSocket 共用一个端口（默认 3109）

## 架构

```
浏览器（任意设备）             服务端（你的 Mac）
┌──────────────────┐         ┌──────────────────────┐
│  xterm.js        │◄──WS──►│  server.ts            │
│  （终端 UI）      │         │  ├─ Next.js（页面）    │
│  + backend 标签   │         │  ├─ WebSocket 服务器   │
│                  │         │  └─ TerminalManager   │
│  IndexedDB       │         │     ├─ tmux:ccrt-#1   │──► claude（PTY）
│  （Session 列表）  │         │     ├─ tmux:ccrt-#2   │──► codex（PTY）
│                  │         │     ├─ tmux:ccrt-#3   │──► kimi（PTY）
└──────────────────┘         │     └─ ...            │
                             │                       │
                             │  历史扫描器：           │
                             │  ~/.claude/projects/* │
                             │  ~/.codex/sessions/*  │
                             │  ~/.kimi-code/sessions│
                             └──────────────────────┘
```

- **server.ts** — Next.js 页面 + WebSocket（`/ws/terminal`）共用的 HTTP 服务
- **TerminalManager** — 管 tmux + PTY 生命周期、环形缓冲、attach/detach
- **backends.ts** — 选 `claude` / `codex` / `kimi` 可执行文件，构造对应 argv（包括各自的续会话语义：`--resume` / `resume` / `-S`）
- **history-index.ts** — 扫描 `~/.claude/projects/*/`（Claude Code）、`~/.codex/sessions/*/`（Codex）、`~/.kimi-code/sessions/*/`（Kimi，经它的 `session_index.jsonl`），汇成统一的历史浏览
- **transcript-hub.ts / transcript-parser.ts / session-discovery.ts** — 只读的对话层：找到 CLI 为某个 live session 写的 transcript 文件，增量 tail、解析成结构化消息 + 元信息（模型、token、分支、工具调用），推给对话视图。CLI 和终端那条路一点不动。
- **WebSocket 协议** — JSON 消息：`create` / `attach` / `input` / `resize` / `kill` / `list`（终端），外加 `chat_attach` / `chat_event` / `chat_input` / `interrupt` / `watch_status`（对话 + 实时状态）

## 快速开始

### 前置要求

- Node.js 20+（或 Bun）
- tmux（macOS `brew install tmux`）
- 至少装一个：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — 查找路径：`~/.local/bin/claude`、`/opt/homebrew/bin/claude`、`/usr/local/bin/claude`
  - [Codex CLI](https://github.com/openai/codex) — 查找路径：`/opt/homebrew/bin/codex`、`/usr/local/bin/codex`、`~/.local/bin/codex`
  - [Kimi Code CLI](https://moonshotai.github.io/kimi-code/) — 优先查 `~/.kimi-code/bin/kimi`（它的安装器不会把自己加进 PATH），再查 `~/.local/bin/kimi` 和 Homebrew 目录

  只装一个也行，UI 只是创建对应缺失 backend 的 session 时会报错。

- macOS（node-pty 预编译为 darwin-arm64；Linux 需重新编译）

### 安装运行

```bash
git clone https://github.com/AliceLJY/agentdeck.git
cd agentdeck
npm install

# 本地开发：生成私有 env 文件，不在终端打印 token
umask 077
printf 'AGENTDECK_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.local

# 构建并启动
npm run build
npm start
```

浏览器打开 `http://localhost:3109`，在登录框粘贴 token。token 会存在当前浏览器里。侧边栏 "+" 按钮新建终端；在首页用 All / CC / Codex 筛选切换新终端使用的后端。

### 远程访问（Tailscale）

服务默认只监听 `127.0.0.1`。需要远程访问时，显式绑定 Tailscale 地址（优先）；只有主机防火墙已配置好时，才绑定全部网卡：

```bash
AGENTDECK_HOST=100.x.x.x npm start
```

启用网络监听后，服务会自动检测并打印 Tailscale URL：

```
[agentdeck] Tailscale: http://100.x.x.x:3109
```

Tailnet 内设备访问 `http://100.x.x.x:3109` 后，在登录框粘贴 token。不要把 token 放进 URL，避免进入浏览器历史和日志。

### 开机自启（macOS launchd）

先把随机 token 存进仓库外的私有文件。这个命令会创建 `~/.config/agentdeck/token`（目录权限 `700`、文件权限 `600`），并把 token 复制到剪贴板，全程不在终端打印：

```bash
npm run token:init
```

先创建私有日志目录，再把下面这个 plist 写进 `~/Library/LaunchAgents/com.agentdeck.web.plist`。plist 本身不含 token；启动包装器会先验证私有文件的类型、属主、权限和格式，再读取 token。

```bash
install -d -m 700 ~/Library/Logs/agentdeck
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentdeck.web</string>
  <key>WorkingDirectory</key><string>/Users/你的用户名/Projects/agentdeck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/你的用户名/Projects/agentdeck/scripts/run-launchd.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>3109</string>
    <key>AGENTDECK_HOST</key><string>100.x.x.x</string>
  </dict>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/你的用户名/Library/Logs/agentdeck/out.log</string>
  <key>StandardErrorPath</key><string>/Users/你的用户名/Library/Logs/agentdeck/err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agentdeck.web.plist
```

其他设备需要当前 token 时运行 `npm run token:copy`；需要轮换时再次运行 `npm run token:init`，再重启 LaunchAgent。两个命令都不会打印 token。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AGENTDECK_TOKEN` | （必填） | 认证 token；开发时直接注入，launchd 模式由私有文件包装器注入 |
| `AGENTDECK_TOKEN_FILE` | `~/.config/agentdeck/token` | launchd 私有 token 文件；必须由当前用户拥有且权限为 `600` |
| `AGENTDECK_HOST` | `127.0.0.1` | 监听地址；远程访问时显式设为 Tailscale IP 或 `0.0.0.0` |
| `PORT` | `3109` | 服务端口 |
| `NODE_ENV` | `development` | 设为 `production` 使用优化构建 |
| `AGENTDECK_TIME_ZONE` | `Asia/Singapore` | 对话记录时间戳使用的 IANA 时区 |

项目在接入第二个后端之前叫 `cc-remote-term`。旧的 `CC_TERMINAL_*` 变量和旧的
`~/.config/cc-remote-term/token` 路径仍作为兜底读取，原地升级无需改任何配置。

Session 参数（`lib/types.ts`）：

| 常量 | 默认值 | 说明 |
|---|---|---|
| `MAX_SESSIONS` | 10 | 最大并发 PTY 数 |
| `IDLE_TIMEOUT` | 30 分钟 | 空闲 Session 自动回收 |
| `RING_BUFFER_SIZE` | 5 MB | 每个 Session 的输出历史缓冲（attach / 重连时 replay） |

## 技术栈

- **前端**：Next.js 16（App Router）、React 19、Tailwind CSS 4、xterm.js 6
- **后端**：Node.js HTTP 服务器、WebSocket（ws）、node-pty、tmux（session 持久化）
- **存储**：IndexedDB（客户端 Session 列表）；服务端 session metadata 持久化在 `~/.agentdeck-sessions.json`

## 致谢

感谢 [Happy](https://github.com/slopus/happy) 的启发。

## 许可

MIT
