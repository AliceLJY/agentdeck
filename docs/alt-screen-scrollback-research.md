# Alt Screen Scrollback 方案研究

> 研究日期：2026-04-15
> 目标：让 cc-remote-term 在 web 端跑 Claude Code / vim / tmux 等 TUI 程序时，用户能用鼠标滚轮向上翻历史（Mac Terminal.app 同款体验）

---

## 1. 问题根源

所有使用 **alt screen buffer** 的 TUI 程序（`\x1b[?1049h` / `\x1b[?47h` / `\x1b[?1047h`），POSIX 标准行为是「alt screen 期间没有 scrollback」。终端模拟器收到 alt screen 激活信号后：

- 切换显示到 alternate buffer（长度仅 rows，无历史）
- 鼠标滚轮事件被转成方向键 `\x1b[A`/`\x1b[B` 送给 app
- 原 normal buffer 的 scrollback 仍在内存，但**不可见、不可滚**

这不是 xterm.js / ghostty-web 的 bug，而是 POSIX 正统。Mac Terminal.app、iTerm2 之所以能在 alt screen 下滚轮翻历史，是因为它们**在 app 层拦截滚轮事件**——不让滚轮信号进入 PTY，转为滚自己维护的历史缓存。

## 2. 现有方案调研

### 2.1 Mac Terminal.app / iTerm2
App 层拦截滚轮，滚 app 自己维护的历史缓存。**这是我们要复刻的体验。**

### 2.2 OpenCode（Tauri desktop app）
- 前端引擎：`ghostty-web`（Ghostty WASM）
- 自写 **SerializeAddon**（`packages/app/src/addons/serialize.ts`，634 行，MIT）
- **用途**：会话持久化（刷新页面恢复 buffer），**不是运行时 scrollback**
- **不解决** alt screen 滚轮翻历史

### 2.3 vibetunnel（独立 web 终端产品，4405 stars）
- 前端引擎：`ghostty-web@^0.4.0`
- 后端：Node.js + node-pty，WebSocket v3 二进制协议
- **alt screen 处理**：按 POSIX 正统——`src/client/components/terminal.ts` 和 `src/server/services/terminal-manager.ts` **grep `alt|alternat` 零匹配**
- 押注：用户该用 tmux 翻历史，浏览器层不拦
- **不解决** 我们的痛点

### 2.4 xterm.js issue #3184
"Give an option to keep scrollback in alt screen"——挂了 5 年无进展。

### 2.5 ghostty-web API：`attachCustomWheelEventHandler`
- 理论上可拦截 alt 屏滚轮，自己实现"滚 normal buffer"
- `[待确认]` 实际可行性：ghostty-web 是否允许前端强制切 buffer 显示
- vibetunnel 没用这条路（证据缺失）

## 3. 方案对比

| 方案 | 做法 | 工作量 | 风险 | 最终效果 |
|------|------|--------|------|----------|
| A 换 ghostty-web（vibetunnel 同款） | 换引擎，不做 UI 拦截 | 1 天 | 中（ghostty-web #148 Codex 粘贴 bug + 关 React Strict Mode + npm 0.4.0 滞后 main 15 commits） | **不解决痛点**（跟 xterm.js 默认行为一致） |
| B 换 ghostty-web + customWheelEventHandler | 换引擎 + 用新 API 劫持滚轮 | 1-2 天 | 中（同上 + `[待确认]` 的 API 可行性） | Mac Terminal.app 级 |
| **C 保留 xterm.js + overlay + SerializeAddon**（选中） | 拦截 alt 屏滚轮 → 独立 xterm 实例接收序列化的 normal buffer → 允许滚动 | 2-4h | 低 | Mac Terminal.app 级 |

## 4. 选型：方案 C

**理由**：
1. **工期**：2-4h vs 1-2 天，当下可用
2. **风险**：不换引擎，不接 ghostty-web 未关 bug（#140/#147/#148/#141/#139）
3. **React Strict Mode 可保留**（开着更健康）
4. **SerializeAddon 可顺手做会话持久化**（刷新页面恢复 buffer）——这是 C 的额外红利
5. **未来演进不堵死**：若 ghostty-web 成熟（0.5 发布 + #148 修复），可迁移到方案 B

## 5. 技术路径（概要）

1. 保留当前 xterm.js 主 terminal，它内部 `buffer.normal` 在 alt screen 期间仍在累积
2. 移植 OpenCode 的 SerializeAddon（`packages/app/src/addons/serialize.ts`）
3. 加一个 overlay React 组件，覆盖在主 terminal 上
4. 检测 `buffer.active.type === 'alternate'` + 拦截 wheel 事件：
   - 向上滚 → 打开 overlay，独立 xterm 实例接收 SerializeAddon 序列化的 normal buffer
   - 用户在 overlay 内自由滚历史
   - 滚到底 / ESC / 点击外部 → 关闭 overlay，回到主 terminal 实时
5. 触发行为：**纯滚轮**（Mac Terminal.app 同款，用户确认）
6. 非 alt screen 状态下，滚轮走 xterm 原生 scrollback，不激活 overlay

## 6. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| SerializeAddon 在当前 xterm.js 版本 API 变动 | Medium | 直接用 OpenCode 版本（`ITerminalCore` 公共接口），验证 cc-remote-term 的 xterm.js 版本兼容 |
| wheel 事件拦截误触发（htop/btop 等真用滚轮的 TUI） | Low | 用户已确认：日常不用 htop/btop，这类场景有方向键 fallback |
| overlay 独立 xterm 实例内存/性能开销 | Low | 仅在需要时创建，关闭时 dispose；scrollback 已限 10000 行 |
| 移动端触摸手势 | Medium | 独立一轮跨平台测试（Chrome Mac / iOS Safari / Android Chrome） |
| 主 terminal 在 overlay 打开期间仍接收 PTY 输出 | Low | 设计上主 terminal 继续接收，overlay 只是冻结历史视图 |

## 7. 不选方案 B 的理由（未来演进考虑）

方案 B（换 ghostty-web + customWheelEventHandler）长期是更优架构，但当下：
- `[待确认]` customWheelEventHandler + buffer.normal 强制显示的可行性
- ghostty-web #148（Codex CLI Ctrl+V 粘贴坏）直接影响 Claude Code 使用
- npm 0.4.0 落后 main 15 commits，未发新版
- 需要关 React Strict Mode

**观察点（触发迁移条件）**：
- ghostty-web 0.5 发布，#148 修复
- 有项目在生产跑通 customWheelEventHandler + alt screen scrollback
- cc-remote-term 开始需要 VT 正确性更强的场景（复杂 Unicode / XTPUSHSGR）

届时启动方案 B 迁移。

---

## 附录：关键文件路径

- cc-remote-term 主终端组件：`components/TerminalView.tsx:65-328`
- cc-remote-term 全局 CSS：`app/globals.css:59-68`（xterm-viewport）
- OpenCode SerializeAddon：`packages/app/src/addons/serialize.ts`（MIT 上游）
- ghostty-web 滚轮源码（参考）：`lib/terminal.ts:1543-1605`
- xterm.js alt screen issue：https://github.com/xtermjs/xterm.js/issues/3184

## 附录：Sources

- [sst/opencode GitHub](https://github.com/sst/opencode)
- [amantus-ai/vibetunnel GitHub](https://github.com/amantus-ai/vibetunnel)
- [coder/ghostty-web GitHub](https://github.com/coder/ghostty-web)
- [xterm.js issue #3184](https://github.com/xtermjs/xterm.js/issues/3184)
- [hosenur/portal GitHub（查证为虚标，无 terminal 实现）](https://github.com/hosenur/portal)
