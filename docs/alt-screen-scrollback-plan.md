# Alt Screen Scrollback — 实施计划

> 计划日期：2026-04-15
> 决策结果：方案 C（xterm.js + overlay）+ server RingBuffer 扩容「混合·简化版」
> 工作量预估：2-3h
>
> 决策历程：
> - 初版 plan 用 IDB 做客户端 snapshot 持久化
> - 用户确认三端（桌面/手机/iPad）都要用 → IDB 单设备本地存储无法跨端
> - 改为扩大服务端 RingBuffer（1MB → 5MB），跨端天然生效，代码改动一行
> Research 文档：`docs/alt-screen-scrollback-research.md`

---

## 目标（验收标准）

1. **核心**：在主 terminal（xterm.js）上，检测到处于 alt screen 时，用户向上滚轮 → 弹出 overlay 面板
2. **Overlay**：独立 xterm 实例，渲染主 terminal 的 `buffer.normal` 完整 scrollback（通过 SerializeAddon 序列化）
3. **退出 overlay**：滚到底 / 按 ESC / 点击外部 → 面板淡出，回到主 terminal 实时
4. **非 alt screen 状态下**：滚轮走 xterm 原生 scrollback，不激活 overlay（保持默认行为）
5. **持久化红利**：服务端 RingBuffer 从 1MB → 5MB，跨三端重连时 replay 范围更大
6. **非回归**：主 terminal 的所有现有功能（WebSocket 重连、theme、resize、KeyBar、FileUpload）不变

## 方案概述

```
┌─────────────────────────────────────────────────────────────┐
│ 主 TerminalView（xterm.js 实例）                            │
│  ├─ 接收 WebSocket PTY 字节流                               │
│  ├─ 加载 SerializeAddon（@xterm/addon-serialize）           │
│  ├─ wheel 事件拦截：buffer.active.type === 'alternate' 时   │
│  │   └─ 向上滚 → 触发 overlay 打开                          │
│  └─ Theme/Resize/WebGL/FitAddon 保持不变                    │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ ScrollbackOverlay（独立 xterm 实例，absolute 覆盖层）│  │
│ │  ├─ 挂载时：serializeAddon.serialize({onlyBuffer:    │  │
│ │  │           'normal'}) → write 到独立实例           │  │
│ │  ├─ 滚动到底部 / ESC / 点击外部 → 淡出销毁           │  │
│ │  └─ 只读：不接 PTY，不接 WebSocket                   │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ IDB 持久化（useTerminalSessions 扩展）                      │
│  ├─ visibilitychange / beforeunload → serialize + 存 IDB   │
│  └─ mount 时：从 IDB 读 + write 重放                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 阶段 1：ScrollbackOverlay（核心 2-3h）

### Step 1.1：添加 SerializeAddon 依赖

**文件**：`package.json`

```bash
cd ~/Projects/cc-remote-term
npm install @xterm/addon-serialize
```

**[待验证]** `@xterm/addon-serialize` 的版本是否匹配 `@xterm/xterm@^6.0.0`。
- 验证方法：`npm info @xterm/addon-serialize` 看 peerDependencies
- 如果 serialize addon 官方包还没 v6 版本，fallback 方案：从 sst/opencode `packages/app/src/addons/serialize.ts` 移植（634 行 MIT）

**ReAct 检查点**：装完后运行 `npm run build` 确认没冲突

---

### Step 1.2：在 TerminalView 中加载 SerializeAddon

**文件**：`components/TerminalView.tsx`

**改动位置**：第 110-140 行 `init` 函数内，在 FitAddon 加载后

```tsx
// 现有代码
fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());

// 新增
const { SerializeAddon } = await import('@xterm/addon-serialize');
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);
serializeAddonRef.current = serializeAddon;
```

**同步新增 ref**：

```tsx
const serializeAddonRef = useRef<SerializeAddon | null>(null);
```

**ReAct 检查点**：打开浏览器 DevTools，主 terminal 正常渲染 → `window.__test = serializeAddonRef.current.serialize()` 能输出字符串

---

### Step 1.3：检测 alt screen + 拦截 wheel

**文件**：`components/TerminalView.tsx`

**改动位置**：`init` 函数内 term.open 之后

**核心逻辑**：

```tsx
// 拦截 wheel 事件 at viewport level
const viewport = containerRef.current.querySelector('.xterm-viewport') as HTMLElement | null;
if (viewport) {
  const wheelHandler = (e: WheelEvent) => {
    // 只处理向上滚（deltaY < 0）
    if (e.deltaY >= 0) return;
    // 只在 alt screen 激活时拦截
    if (term.buffer.active.type !== 'alternate') return;
    // 阻止默认 → 不让 xterm 把滚轮转成箭头键发给 PTY
    e.preventDefault();
    e.stopPropagation();
    // 触发 overlay 打开（通过 ref 回调 parent）
    onScrollbackRequestRef.current?.();
  };
  viewport.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
  // 记在 disposables 里统一清理
}
```

**[待验证]** xterm.js 6.0.0 的 `term.buffer.active.type` 是否返回 `'normal' | 'alternate'`。
- 验证：`console.log(term.buffer.active.type)` 在 cc 启动前/后对比

**向上暴露 API**：TerminalView 通过 props/ref 提供 "当前是否 alt screen" + "请求 serialize" 两个能力给 parent

**ReAct 检查点**：
1. 非 cc 状态下滚轮：走 xterm 原生 scrollback（正常）
2. 进 cc 后滚轮：触发 onScrollbackRequest 回调（console.log 可见）

---

### Step 1.4：ScrollbackOverlay 组件

**新文件**：`components/ScrollbackOverlay.tsx`

```tsx
'use client';

import { useRef, useEffect } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';

interface Props {
  serializedContent: string;       // 从主 term SerializeAddon 产出
  theme: 'light' | 'dark';
  onClose: () => void;
}

export default function ScrollbackOverlay({ serializedContent, theme, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: false,  // 只读
        disableStdin: true,
        fontSize: 16,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: theme === 'dark' ? darkTheme : lightTheme,
        scrollback: 10000,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      term.write(serializedContent);
      term.scrollToBottom();  // 初始停在最新

      // 滚到底自动关闭
      term.onScroll(() => {
        const max = term.buffer.active.length - term.rows;
        if (term.buffer.active.viewportY >= max) {
          // 滚到底了 → 延迟关闭避免一下子就关
          setTimeout(() => !disposed && onClose(), 300);
        }
      });

      termRef.current = term;
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  return (
    <div
      className="absolute inset-0 z-40 bg-gray-900/95 backdrop-blur-sm flex flex-col"
      onClick={(e) => {
        // 点击外部（非 xterm）关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="h-10 flex items-center justify-between px-4 border-b border-white/10">
        <span className="text-xs text-gray-300">Scrollback · ESC 关闭</span>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-white">×</button>
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}

// 主题复用 TerminalView 的 darkTheme / lightTheme（提出为共享模块）
```

**ReAct 检查点**：
1. overlay 打开后：独立 xterm 渲染序列化内容
2. ESC：overlay 消失
3. 滚到底：overlay 自动关
4. 点击 backdrop：overlay 消失
5. 主 term 在 overlay 期间**仍在接收 PTY 输出**（cc 继续跑没有阻塞）

---

### Step 1.5：在 page.tsx 集成 overlay 状态

**文件**：`app/page.tsx`

**新增 state**：

```tsx
const [scrollbackContent, setScrollbackContent] = useState<string | null>(null);
```

**新增回调传给 TerminalView**：

```tsx
const handleScrollbackRequest = useCallback(() => {
  const serialized = terminalViewRef.current?.serialize();
  if (serialized) setScrollbackContent(serialized);
}, []);
```

**渲染**：

```tsx
{scrollbackContent && (
  <ScrollbackOverlay
    serializedContent={scrollbackContent}
    theme={resolved}
    onClose={() => setScrollbackContent(null)}
  />
)}
```

**ReAct 检查点**：端到端——在 cc 里滚轮 → overlay 出现 → 看到 primary buffer 内容（虽然可能是空或很少内容，符合 research.md 的预期）→ ESC 回 cc

---

## 阶段 2：服务端 RingBuffer 扩容（15min）

### Step 2.1：扩大 RING_BUFFER_SIZE

**文件**：`lib/types.ts:53`

**当前**：
```ts
export const RING_BUFFER_SIZE = 1024 * 1024;       // 1MB
```

**改为**：
```ts
export const RING_BUFFER_SIZE = 5 * 1024 * 1024;   // 5MB — 覆盖更长的 cc 会话历史（三端重连 replay 范围）
```

### Step 2.2：同步更新 README / README_CN

**文件**：`README.md:100` 和 `README_CN.md:94`

改表格里的 `1 MB` → `5 MB`。

### Step 2.3：评估内存影响

`MAX_SESSIONS` 现值（`lib/types.ts` 里看）决定上限内存。

**[待实施时确认]** 比如如果 MAX_SESSIONS=10，最坏情况 10 × 5MB = 50MB 堆占用，对 Mac mini / Tailscale 机器都可接受。

**ReAct 检查点**：
1. 启动服务，跑一段 cc，`ps` 或 activity monitor 看 node 进程内存
2. 刷新页面 → attach 时 server replay 能看到更长历史
3. 跨端测试：桌面跑 cc，手机接着连，replay 到 5MB 的内容

---

## 阶段 3：跨平台测试（1h）

**Chrome 桌面（Mac）**：
- [ ] 非 cc 状态下滚轮翻 xterm 原生 scrollback
- [ ] cc 内滚轮向上 → overlay 打开
- [ ] overlay 内滚动 / ESC / 滚到底自动关
- [ ] 刷新页面 → buffer 恢复（IDB）

**iOS Safari（iPad + iPhone，必做）**：
- [ ] 触摸滑动能否触发 overlay（wheel 事件在 iOS 上需要额外处理，passive touchmove 替代）
- [ ] overlay 内触摸滚动
- [ ] xterm.js iOS WebGL garble 问题是否影响 overlay（应该不会，overlay 默认 DOM renderer）
- [ ] Safari 地址栏和 home indicator 是否遮挡 overlay 关闭按钮

**Android Chrome（必做）**：
- [ ] 基本触摸行为
- [ ] 虚拟键盘弹出时 overlay layout

**移动端特有考虑（重点）**：
- wheel 事件在移动端**不触发**，需要监听 `touchmove` 或 `touchstart` → `touchend` 的方向判断
- 或者在移动端改用"手势"：双指向上滑 / 下拉刷新式触发
- **[待实施时决定]** 移动端触发方式可能需要独立设计，不复用 wheel 逻辑

---

## 阶段 4：更新文档 + commit/push（30min）

1. **README.md**（英文）新增 "Scrollback" section 说明
2. **README_CN.md**（中文）同步
3. commit 信息：
   ```
   feat: alt screen scrollback overlay + expand ring buffer

   - Detect alt screen + intercept wheel/touchmove → show overlay with SerializeAddon'd normal buffer
   - Expand server RingBuffer from 1MB to 5MB for longer cross-device replay
   - Research & plan: docs/alt-screen-scrollback-research.md, docs/alt-screen-scrollback-plan.md
   ```
4. 推到 main（用户是 maintainer，无需 PR）

---

## 风险清单 + 缓解

| 风险 | 缓解 |
|------|------|
| xterm.js 6.0.0 和 `@xterm/addon-serialize` 版本不匹配 | Fallback: 移植 OpenCode serialize.ts 634 行 |
| `term.buffer.active.type` API 变动 | 实施前跑测试确认 |
| overlay 的 xterm 实例与主实例 theme 共享导致样式偶发 | theme 独立 props 传入，不用 shared state |
| SerializeAddon 在 alt screen 下 serialize 主屏而非 normal 屏 | API 确认：`serialize({ scrollback: N, onlyBuffer: 'normal' })` 或类似选项 |
| 移动端 wheel 不触发 | 独立 touchmove 方向检测逻辑，可能需要二次设计 |
| ring buffer 5MB × MAX_SESSIONS 总内存 | 部署时评估，不超过服务器 RAM 一半 |
| overlay 开着时主 term 继续接 PTY 输出可能导致状态错乱 | 主 term 不冻结（用户要求："cc 不打断"），只是 overlay 盖住 |

---

## 回退策略

如果 Step 1.3 拦截滚轮实际破坏了某些 TUI（比如你发现某个常用程序的滚轮行为没了），回退为：
- **触发改为 Shift+滚轮**（用户选 A 时放弃的 plan B）
- 只改 `if (!e.shiftKey) return;` 一行

---

## Todo List

- [x] research.md
- [ ] Step 1.1 npm install
- [ ] Step 1.2 加载 SerializeAddon
- [ ] Step 1.3 检测 alt screen + 拦截 wheel
- [ ] Step 1.4 ScrollbackOverlay 组件
- [ ] Step 1.5 page.tsx 集成
- [ ] Step 2.1 lib/types.ts 扩大 RING_BUFFER_SIZE 到 5MB
- [ ] Step 2.2 README / README_CN 同步更新
- [ ] Step 2.3 内存评估（活动监视器 / ps）
- [ ] 跨平台测试（桌面 Chrome + iOS Safari / iPad + Android Chrome，**全做**）
- [ ] README 更新
- [ ] commit + push

---

## 待你决策的点

**已决策**（2026-04-15）：
- ✅ 去重策略：改为扩大 server RingBuffer，不做 IDB
- ✅ 跨端测试：桌面 + 手机 + iPad 全做

**你可以在这个文件里直接加 `[注：...]` 注释，我会处理后更新 plan**
