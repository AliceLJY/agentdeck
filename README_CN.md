# AgentDeck

给 AI 编程 CLI 用的 Web 远程终端，一个标签页一个。手机、平板、电脑，任何设备都能通过浏览器连上：走 [frp](https://github.com/fatedier/frp) 反向隧道时不挑网络，不想暴露在公网上时走 [Tailscale](https://tailscale.com/)。

**装任何 agent CLI，不是一份固定名单。** 传输层是 tmux 背后的真 PTY，所以你终端里
能跑的东西，这里都能跑——它从不假设对面是哪个程序。管道部分（重启后会话还在、标签栏、
文件上传、触摸滚动、粘贴）全都与具体 agent 无关，接任何 CLI 都是白拿。

**一个 backend 条目多买到的是「理解」**：对话视图、历史浏览、一键 resume 得知道这家 CLI
把 transcript 放在哪、长什么样。[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、
[Codex](https://github.com/openai/codex)、[Kimi Code](https://moonshotai.github.io/kimi-code/)
内置了这份理解——这三个只是我天天在用、端到端实测过的那几个。接第四个是一天的适配活，
不用动传输层，见[接一个新 CLI](#接一个新-cli)。

**是真终端，不是阉割版聊天框。** xterm.js + node-pty + tmux 完整还原 Claude Code 和 Codex 在终端里的体验——颜色、光标、滚动、链接，一个不少。在这之上再叠一层**可选的对话视图**：同一个 live session 渲染成干净、能滚的消息气泡，手机上读长回复、打字都顺手，底下那个真终端一点没丢。

[English README](./README.md)

![AgentDeck](docs/screenshot.png)

*三个 CLI 并排——顶上是 Kimi、Claude Code、Codex 的标签，侧边栏是聊过的对话。
截图里的 session 标题和项目名都是占位示例。*

## 功能

- **混着开，一个 UI** — 同一个浏览器里能开 Claude Code、Codex、Kimi Code 并排跑；每个 session 用颜色区分 backend（Claude 蓝、Codex 绿、Kimi 紫）。别的 CLI 一样能占一个标签，只是在有人给它写适配之前，没有对话视图和历史这两层
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
- **三端通用** — iPhone、iPad、安卓、电脑浏览器都能连：frp 反向隧道走任意网络，或在 Tailscale 网内直连
- **为拇指做的** — 触摸快捷键栏（Esc、Tab、`^C`、方向键、粘贴）+ iOS 26 IME 输入修复。终端上随便按住哪儿都能拖着翻历史，甩一下有惯性：xterm.js 在 iOS 上只有从**没字的地方**起手才滚得动（[#3613](https://github.com/xtermjs/xterm.js/issues/3613)），而满屏输出时根本找不到空白，所以这个手势改由本项目自己接管。长按仍然出系统的选择菜单；反方向有粘贴按钮兜着——iOS 压根没法碰到终端接收粘贴的那个隐藏输入框
- **复制不再费劲** — 一下点掉：复制一个代码块、复制整条回复、或复制历史视图里的任意一条。代码块按气泡宽度折行，不再横向滚动——在手机上拖那条横向滚动条实在不是人干的事
- **深色/浅色主题** — 跟随系统，侧边栏可切换
- **Token 认证** — token 不会写入页面 HTML；通过 `?token=` 链接或登录框提供，浏览器会记住
- **设备白名单** — 光有 token 还进不来：浏览器还必须是已批准的设备。陌生设备会被拦住，同时给你推一条带一次性批准链接的 Telegram 通知，所以 token 泄露不等于交出一个 shell。手机丢了？撤销那一台就行，其他设备照常用 —— 见 [设备管理](#设备管理)
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

浏览器打开 `http://localhost:3109`，在登录框粘贴 token。token 会存在当前浏览器里。侧边栏 "+" 按钮新建终端；在首页用 All / CC / Codex / Kimi 筛选切换新终端使用的后端。

### 远程访问

服务默认只监听 `127.0.0.1`，所谓「远程访问」其实是在选浏览器怎么够到这个端口。
两条路，可以同时留着，哪条网络允许走哪条。

**反向隧道（frp）——不挑网络。** 手机用流量、酒店 Wi-Fi、别人家 NAT 后面的电脑，
只要够得到你自己的 VPS 就够得到它。在跑 AgentDeck 的机器上跑一个
[frp](https://github.com/fatedier/frp) 客户端，把端口转出去：

```toml
# frpc.toml，放在跑 AgentDeck 的机器上
serverAddr = "vps.example.com"
serverPort = 7000
auth.method = "token"
auth.token = "<你的 frp token>"

[[proxies]]
name = "agentdeck"
type = "tcp"
localIP = "127.0.0.1"   # frpc 在本机连，不必放宽 AGENTDECK_HOST
localPort = 3109
remotePort = 3456
```

> **真用之前先在服务端套上 TLS。** 裸 `tcp` 代理等于把明文 HTTP 发到公网上：
> 访问 token、每一次击键、每一个上传的文件都是明文过网络，而这个端口后面是你
> 机器上的一个可交互 shell。在转发端口前面放 nginx / Caddy，或者用 frp 自己的
> `https2http` 代理配上证书，让浏览器全程走 HTTPS。

**Tailscale——什么都不往公网发。** 只有同一个 tailnet 内的设备能连，适合完全
不想把它暴露在公网上的时候。绑定 Tailscale 地址（优先于 `0.0.0.0`，后者需要
主机防火墙兜着）：

```bash
AGENTDECK_HOST=100.x.x.x npm start
```

服务启动时会自动检测并打印地址：

```
[agentdeck] Tailscale: http://100.x.x.x:3109
```

两条路都一样：token 在登录框里粘贴，别放进 URL——URL 会进浏览器历史、代理日志和
referrer 头。

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
| `AGENTDECK_HOST` | `127.0.0.1` | 监听地址。用 frp 转发时保持默认即可（隧道在本机连）；只有要直连 LAN / Tailscale 时才放宽：设为 Tailscale IP，或在主机防火墙兜底的前提下设 `0.0.0.0` |
| `PORT` | `3109` | 服务端口 |
| `NODE_ENV` | `development` | 设为 `production` 使用优化构建 |
| `AGENTDECK_TIME_ZONE` | `Asia/Singapore` | 对话记录时间戳使用的 IANA 时区 |
| `AGENTDECK_TG_BOT_TOKEN` | 未设置 | 推送新设备告警的 Telegram bot。不设置则只写服务器日志 —— 白名单照样拦，只是要自己去看 |
| `AGENTDECK_TG_CHAT_ID` | 未设置 | 告警发往哪个会话 |
| `AGENTDECK_PUBLIC_URL` | 未设置 | 用于拼批准链接的公网地址，如 `https://term.example.com`。不设置则降级为「到 Mac 上批准」 |
| `AGENTDECK_STRICT_BOOTSTRAP` | 未设置 | 设为 `1` 完全关掉首台自动信任，连本机也不例外。首台设备需手工改白名单文件批准 |
| `AGENTDECK_DEVICES_PATH` | `~/.agentdeck-devices.json` | 设备白名单的位置。起第二个实例时指到别处，免得写进正在用的那份 |

项目在接入第二个后端之前叫 `cc-remote-term`。旧的 `CC_TERMINAL_*` 变量和旧的
`~/.config/cc-remote-term/token` 路径仍作为兜底读取，原地升级无需改任何配置。

## 设备管理

token 只是把你带到门口，开不开门由设备白名单决定。每个浏览器首次加载时生成一个
不透明的 device id 存在 localStorage 里，服务端只在这个 id 已被批准时才放行 ——
WebSocket 升级时会再查一遍，不是只在界面上做样子。

**新设备**：直接拦住，同时往 Telegram 推一条带一次性批准链接的通知。点一下，那台
等着的浏览器几秒内自己就进去了（它在轮询）。被拦的设备自己批准不了自己。

**首台设备**：白名单为空时，**来自本机（loopback）**的连接会被自动收养，所以在 Mac 上
`npm start` 永远不会把你锁在外面。远程来的连接绝不自动收养 —— 从隧道进来撞上一个空
白名单，那是一个待批准请求，不是信任的理由。

**token 被偷**：小偷的浏览器没有已批准的 id，所以会被拦住、你会收到告警。这条告警值得
立刻处置：换 token。

**手机丢了**：在设备面板里撤销那一台，或者：

```bash
curl -X POST -H "x-token: $AGENTDECK_TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"revoke","deviceId":"<id>"}' http://127.0.0.1:3109/api/devices
```

其他设备的会话不受影响。「换掉共享 token」那种把所有设备一起登出的粗暴手段，不再是
唯一选择。

**白名单文件损坏**：文件存在但解析不了时，服务端拒绝所有设备，并原样保留文件等人工修复。
它不会降级成「空白名单」—— 因为「空」正是触发自动收养的条件。

### 边界

device id 是标识不是第二个密钥：如果有人把 token **和** 某台已批准浏览器的 localStorage
一起复制走，他看起来就是那台浏览器。真能抓住这种情况的信号是「同一个 device id 同时从两个
地方连」—— 目前还没做，这是这个功能诚实的边界。

Session 参数（`lib/types.ts`）：

| 常量 | 默认值 | 说明 |
|---|---|---|
| `MAX_SESSIONS` | 10 | 最大并发 PTY 数 |
| `IDLE_TIMEOUT` | 30 分钟 | 空闲 Session 自动回收 |
| `RING_BUFFER_SIZE` | 5 MB | 每个 Session 的输出历史缓冲（attach / 重连时 replay） |

## 接一个新 CLI

内置这三个不是封闭名单，只是端到端实测过的那几个。接第四个的活分成两半，贵的那半还是可选的。

**白拿，一行不用写。** 启动、PTY、tmux 重启后会话还在、标签栏、环形缓冲、文件上传、
触摸滚动、粘贴——这些全都不知道也不关心对面是哪个 CLI。任何交互式程序都直接继承。

**要写的是适配层。** 对话视图、历史浏览、一键 resume 是另一回事：它们要读这家 CLI
自己写在磁盘上的 transcript，就得知道它长什么样。接 Kimi 当第三个 backend 时，动的
恰好就是下面这些，传输层一行没改：

| 文件 | 它需要学会的事 |
|---|---|
| `lib/backends.ts` | argv 规则——怎么启动、怎么 resume、放行哪些 flag、徽章配色 |
| `lib/terminal-manager.ts` | 可执行文件在哪（Kimi 的安装器不进 `PATH`，只查 `PATH` 会误判成「没装」） |
| `lib/history-index.ts` | 会话索引落在磁盘哪里、怎么遍历 |
| `lib/transcript-parser.ts` | transcript 格式——最重的一块。Claude 和 Codex 记的是消息，Kimi 记的是事件流，得折回成消息 |
| `lib/session-discovery.ts` | 怎么认出刚起的这个会话对应哪份 transcript |
| UI | 新建面板一个选项、首页一个筛选、一个颜色 |

各家格式的差别比想象中大，所以这是一天的活而不是改个配置——但它**始终**只是一天的活，
因为传输层从头到尾不参与。

## 技术栈

- **前端**：Next.js 16（App Router）、React 19、Tailwind CSS 4、xterm.js 6
- **后端**：Node.js HTTP 服务器、WebSocket（ws）、node-pty、tmux（session 持久化）
- **存储**：IndexedDB（客户端 Session 列表）；服务端 session metadata 持久化在 `~/.agentdeck-sessions.json`

## 致谢

感谢 [Happy](https://github.com/slopus/happy) 的启发。

## 许可

MIT
