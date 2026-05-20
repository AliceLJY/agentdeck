# cc-remote-term

基于 Web 的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 远程终端。手机、平板、电脑，任何设备都能通过浏览器访问你的 Claude Code。

**不是阉割版聊天界面。** 这是真正的终端模拟器（xterm.js + node-pty），完整还原 Claude Code 在终端里的体验——颜色、光标、滚动、链接，一个不少。

## 功能

- **真终端** — xterm.js 渲染完整终端体验，不是 Markdown 聊天框
- **多 Session** — 点 "+" 无限开新终端，随意切换，互不干扰
- **Session 保持** — 切走再切回来，输出历史还在（1MB 环形缓冲区）
- **文件上传** — 拖拽文件到终端区域，或点回形针按钮上传
- **三端通用** — iPhone、iPad、安卓、电脑浏览器，通过 Tailscale 随时访问
- **iPad 友好** — 触摸快捷键栏（Esc、Tab、Ctrl+C、方向键）
- **深色/浅色主题** — 跟随系统，侧边栏可切换
- **Token 认证** — 简单 token 保护你的终端
- **开机自启** — 附带 macOS launchd 配置，重启电脑自动恢复服务
- **单端口** — HTTP + WebSocket 共用一个端口（默认 3109）

## 架构

```
浏览器（任意设备）             服务端（你的 Mac）
┌──────────────────┐         ┌────────────────────┐
│  xterm.js        │◄──WS──►│  server.ts          │
│  （终端 UI）      │         │  ├─ Next.js（页面）  │
│                  │         │  ├─ WebSocket 服务器  │
│  IndexedDB       │         │  └─ TerminalManager │
│  （Session 列表） │         │     ├─ node-pty #1  │──► claude（PTY）
└──────────────────┘         │     ├─ node-pty #2  │──► claude（PTY）
                             │     └─ ...          │
                             └────────────────────┘
```

## 快速开始

### 前置要求

- Node.js 20+（或 Bun）
- 已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`~/.local/bin/claude`）
- macOS（node-pty 预编译为 darwin-arm64；Linux 需重新编译）

### 安装运行

```bash
git clone https://github.com/AliceLJY/cc-remote-term.git
cd cc-remote-term
npm install

# 生成随机 token
export CC_TERMINAL_TOKEN=$(openssl rand -hex 24)
echo "CC_TERMINAL_TOKEN=$CC_TERMINAL_TOKEN" > .env.local
echo "你的 token: $CC_TERMINAL_TOKEN"

# 构建并启动
npm run build
npm start
```

浏览器打开 `http://localhost:3109?token=你的TOKEN`

### 远程访问（Tailscale）

安装了 [Tailscale](https://tailscale.com/) 的话，启动时会自动检测 Tailscale IP：

```
[cc-terminal] Tailscale: http://100.x.x.x:3109
```

在 Tailnet 内任何设备访问：`http://100.x.x.x:3109?token=你的TOKEN`

### 开机自启（macOS launchd）

```bash
cp scripts/com.cc-remote-term.web.plist ~/Library/LaunchAgents/
# 编辑 plist 里的路径和 token，然后：
launchctl load ~/Library/LaunchAgents/com.cc-remote-term.web.plist
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CC_TERMINAL_TOKEN` | （必填） | WebSocket 认证 token |
| `PORT` | `3109` | 服务端口 |
| `NODE_ENV` | `development` | 设为 `production` 使用优化构建 |

Session 参数（`lib/types.ts`）：

| 常量 | 默认值 | 说明 |
|---|---|---|
| `MAX_SESSIONS` | 10 | 最大并发 PTY 数 |
| `IDLE_TIMEOUT` | 30 分钟 | 空闲 Session 自动回收 |
| `RING_BUFFER_SIZE` | 5 MB | 每个 Session 的输出历史缓冲（attach / 重连时 replay） |

## 技术栈

- **前端**：Next.js 16（App Router）、React 19、Tailwind CSS 4、xterm.js 6
- **后端**：Node.js HTTP 服务器、WebSocket（ws）、node-pty
- **存储**：IndexedDB（客户端 Session 列表）

## 致谢

感谢 [Happy](https://github.com/slopus/happy) 的启发。

## 许可

MIT
