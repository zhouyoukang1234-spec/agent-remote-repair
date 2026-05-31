# Agent Remote Repair Hub v8.7

> Ed25519端到端 · 道法自然 · 万法归宗 · 零成本 · 零配置 · 零注册

远程 Windows/Android 诊断、修复、**投屏**与**控制**系统。
**一行命令，完全自动。无需安装任何东西。**

## 一行启动 (小白专用)

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/zhouyoukang1234-spec/agent-remote-repair/main/install.ps1 | iex
```

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/zhouyoukang1234-spec/agent-remote-repair/main/install.sh | bash
```

**就这样。** 脚本自动完成：
1. **检测/安装 Node.js** — 无 Node 自动下载安装 (静默)
2. **下载项目** — 无需 Git，从 GitHub ZIP 直接下载 (多镜像自适应)
3. **安装依赖** — npm install (国内自动切 npmmirror)
4. **启动系统** — Hub + Relay + **公网 HTTPS 隧道** 全自动
5. **浏览器打开** `http://localhost:3002` 即可

> 端口默认 3002，若被占用自动递增。cloudflared 自动下载(多镜像)，自动获取 HTTPS 公网 URL。
> 整个过程 **零费用 · 零域名 · 零注册 · 零配置**。

## 已有 Node.js？更快

```bash
git clone https://github.com/zhouyoukang1234-spec/agent-remote-repair.git
cd agent-remote-repair
npm install && npm start
```

## 自检 (可选)

```bash
npm test              # 45 单元 + 29 端点集成 (不需外网, 不依赖投屏硬件)
npm run test:unit     # 仅跑 _test_wuwei.js (模块契约)
npm run test:endpoints # 仅跑 _test_endpoints.js (拉起 hub 真实打端点)
```

覆盖: `/dao/discover` · `/status` · `/api/health` · `/tools` · `/pair(+claim)` · `/c` · PWA · `/files` · `/dao/wol` · `/dao/clipboard` · `/dao/mdns` · `/dao/record` · `/screen/sources` · `/go` · `/sense` · `/brain/state`

## 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Node.js** | **≥ 18.0** | 一键脚本自动安装，无需手动 |
| Python | ≥ 3.8 | 可选 — PS Agent Relay 需要，Hub 无 Python 也能独立运行 |
| ADB | 任意 | 可选 — Android 控制/投屏需要 |

## 安全架构 (v8.0 重建)

- **Ed25519 非对称身份**: 每设备唯一 Ed25519 密钥对，私钥签名/公钥验证，不可伪造
- **签名令牌**: `dao2.*` 格式，任何人可用公钥验证，仅发行者可创建
- **前向安全**: X25519 ECDH 密钥交换 + AES-256-GCM 端到端加密 (每连接独立)
- **速率限制**: 20次/分钟/IP 防暴力破解
- **令牌自动刷新**: 7天有效，重启自动轮换
- **v1兼容迁移**: 旧HMAC令牌在过渡期内仍可验证

## 自动能力

- **零成本公网隧道**: cloudflared(自动下载) → ngrok → SSH(localhost.run)，零配置零费用
- **道核驱动 · 唯变所适**: 无硬编码端口/Token/URL
  - `_publicUrl` fallback 自 `os.networkInterfaces()` 首个 LAN IP 涌出, 无 "localhost" 字面裸露
  - `ADB_HUB_TOKEN` 四级涌现 (env > 缓存文件 > Ed25519 签名派生 > 遗留字面量), 每设备唯一, 零共享秘密
  - 外部服务 (scrcpy/mjpeg/adb_hub) 声明 `portCandidates: [base, +1, +2]`, 注册表探测即锁定实际存活端口
- **一表定万法 · 6 种流式投屏源**: ghost_shell / scrcpy / dao-remote / MJPEG / adb_hub / Agent截屏 — 优先级/探测/代理/路由皆源于 `dao_screen_registry` 单表
- **柔弱胜刚强 · 失败即退让**: 任一 capture/input 失败, 源立刻 `markOffline`, 下次调用秒跳下源；不等 30s 周期重探
- **6 级输入路由自适应**: ghost → InputRoutes → MJPEG → dao-remote → adb_hub → scrcpy → ADB兜底
- **远程工具自动检测**: 向日葵 / 无界趣连 / ToDesk / AnyDesk / RustDesk / TeamViewer / Parsec — 通过 `/tools/launch` 一键启动已安装工具（向日葵等 P2P 客户端无本地流式 API，分类为启动器）
- **浏览器实时投屏** + 触控/键盘/文本反向控制

## 设计哲学

- **道法自然** — 零配置，一切自动发现、自动适配
- **万法归宗 · 一表定万法** — `dao_screen_registry` 一处定义，`discover`/`best`/`capture`/`input`/`proxy` 皆为纯委派；新增/删除/调整优先级只动一行
- **反者道之动** — 优先级由 registry 的 `priority` 字段决定: ghost(10) → scrcpy(20) → dao(30) → input(40) → mjpeg(50) → adb_hub(60)
- **柔弱胜刚强** — 服务可随时上下线，30s 自动重探，无感切换
- **去芜留菁** — `captureScreenBest`/`sendInputToDevice` 皆为三行代理；分支逻辑不再散落各处

## 架构

```text
  [目标Windows] ──irm /go | iex──►┐
       ↕ screencap (连续推送)      │
  [Android设备] ──ADB──►──────────┤
       ↕ scrcpy / MJPEG / ADB     │
  [浏览器五感] ──WS──► dao.js ────┤──► remote-agent (WS中枢)
       ↕ /ws/screen (实时投屏)     │       ↕ captureScreenBest()
       ↕ /ws/sense (诊断控制)      │       ↕ sendInputToDevice()
  [公网隧道] ──cloudflared/ngrok/SSH──►┘  ↕ /screen/* (投屏代理)
                                           ↕ /input/* (反向控制)
                              ──► ps-agent (HTTP Relay)
                              ──► ghost_shell :8000 (Windows 30fps)
                              ──► scrcpy Hub :8890 (Android)
                              ──► dao-remote :9900 (Go版亲情远程)
                              ──► MJPEG :8081 / Input :8084
                              ──► adb_hub :9861 (ADB全控中枢)
                              ──► 向日葵 :13333 (本地API探测)
```

### 四层融合

| 层 | 组件 | 作用 |
|----|------|------|
| **道** | `dao_kernel.js` + `dao.js` | 道核(熵源/身份/发现/能力/会话) + 入口 |
| **屏** | `/screen/*` + `/ws/screen` | 6 流源 + Agent兜底: ghost/scrcpy/dao/input/mjpeg/adb_hub，自适应 |
| **手** | `/input/*` + 触控/键盘 | 6 级输入: ghost/InputRoutes/mjpeg/adb_hub/dao/scrcpy + ADB兜底 |
| **脑** | `/brain/*` + 诊断引擎 | 诊断修复: 网络/hosts/防火墙/缓存 |
| **器** | `/tools/*` + 注册表 | P2P 启动器: 向日葵/无界趣连/ToDesk/AnyDesk/RustDesk/TeamViewer/Parsec |

## 投屏与控制

### 浏览器投屏 (零安装)

打开 `http://localhost:3002` → 投屏tab → 截屏/实时投屏

- **单次截屏**: `captureScreenBest()` 自动选最优源
- **实时投屏**: Agent 连续推送屏幕帧 / ghost_shell 30fps WS流
- **触控点击**: 点击屏幕图像直接操控远程设备
- **键盘转发**: 焦点在投屏页时自动转发按键
- **文本输入**: 弹窗输入 → 发送到远程
- **Windows 控制栏**: ghost/dao 在线时自动显示桌面快捷操作

### 投屏源自动发现 (6 流源 + Agent 兜底)

priority 数字定义于 `dao_screen_registry`，越小越优。`capture` 为函数才入选流路径。

| priority | 源 | 端口 | 能力 | 适用 |
|--------|-----|------|------|------|
| 10 | ghost_shell | 8000 | 30fps WS流/截图/桌面控制 | Windows |
| 20 | scrcpy Hub | 8890 | 截图/录制/控制/多设备 | Android |
| 30 | dao-remote | 9900 | 截图/桌面控制 (Go版) | Windows |
| 50 | MJPEG | 8081 | 实时MJPEG流 + 同端口输入 | Android |
| 60 | adb_hub | 9861 | ADB截图/shell/多设备 | Android |
| 兜底 | Agent screencap | — | PowerShell桌面截图 | Windows |
| 99 | 向日葵 | 13333 (bridge) | P2P 启动器（`capture=null`）— 通过 `/tools/launch` 调用 | Windows |

### 输入路由优先级

| priority | 源 | 说明 |
|--------|-----|------|
| 10 | ghost_shell | Windows 桌面 30fps 控制 (鼠标/键盘/滚轮) |
| 40 | InputRoutes | Android 120+ API 端点 (input-only, 无 capture) |
| 50 | MJPEG | 同端口输入 |
| 60 | adb_hub | ADB 全控中枢 (tap/swipe/key/text/shell) |
| 30 | dao-remote | 亲情远程 Go 版 |
| 20 | scrcpy Hub | scrcpy API |
| 兜底 | ADB fallback | 原始 `adb shell input` 命令 (在 `sendInputToDevice` reject 后兜底) |

## 端点一览

| 端点 | 说明 |
|------|------|
| `/` | 五感控制台（浏览器） |
| `/go` | 统一 Agent 脚本（自动 ws/wss，多路径） |
| `/api/health` | Hub 健康探针 |
| `/screen/sources` | 投屏源状态 + 最优源 |
| `/screen/capture` | 截屏 (mode=auto/ghost/scrcpy/dao/sunlogin/adb_hub/agent) |
| `/screen/stream` | 实时流代理 |
| `/screen/scrcpy/*` | scrcpy Hub API 代理 |
| `/screen/ghost/*` | ghost_shell API 代理 |
| `/screen/dao/*` | dao-remote API 代理 |
| `/screen/adb/*` | adb_hub API 代理 |
| `/screen/sunlogin/*` | 向日葵本地API代理 |
| `/tools` | 远程工具注册表 (自动检测向日葵/无界趣连/ToDesk/AnyDesk等) |
| `/tools/launch` | 一键启动指定工具 (POST {id}) |
| `/tools/auto` | 自动启动最优可用工具 |
| `/input/{action}` | 反向控制 (tap/swipe/key/text/home/back/scroll/...) |
| `/ws/screen` | WebSocket 实时投屏 + 输入通道 |
| `/ws/sense` | WebSocket 诊断控制台 |
| `/ws/agent` | WebSocket Agent 连接 |
| `/status` | 系统状态 JSON |
| `/dao/discover` | **身份+LAN IP+端口+NAT 状态**（无需 token，客户端自发现的唯一入口） |
| `/pair?format=html\|svg\|png\|ascii\|json` | **一码配对**：QR 二维码；QR 中 URL 为 `http(s)://<host>/c#<pairId>.<fp>` |
| `/pair/claim` | **POST `{pairId}`** → 一次性返回 Ed25519 长 token |
| `/c` | **PWA 落地页**：手机扫 QR 自动打开此页 → 自动 claim → TOFU 缓存 → 跳 `/sense` |
| `/manifest.webmanifest`, `/icon.svg` | PWA 可安装 |
| `/relay/*` | PS Agent Relay 代理 |
| `/brain/exec` | 远程执行命令 |
| `/brain/auto` | 自动诊断 |
| `/marble` | 3D 世界 Gaussian Splatting Viewer (需 `WLT_API_KEY`) |

## 无为而治 · 五感涌现 (v8.1+)

**零配置零字面量** — 所有端口/令牌/URL 从 Ed25519 身份或运行时探测涌现：

- **ADB_HUB_TOKEN** 从 `identity.serviceToken("adb_hub")` 确定性派生，跨重启稳定，跨进程等价
- **LAN 多播信标**（`dao_rendezvous.js`）周期广播 hub 身份 + LAN IP + 端口至 `239.77.76.75:7777`，客户端无 URL 即可自发现
- **NAT 自穿**（`dao_nat.js`）并行尝试 UPnP IGD → NAT-PMP 打开路由器映射，不依赖 cloudflared/ngrok 也能公网直达
- **一码配对**（`dao_pair.js`）零依赖纯 JS QR 编码 + `dao://` URI，手机扫码 = 认身份 + 拿令牌 + 知坐标
- **请求自知 URL** — 每条响应从请求 Host 头自描述，不再预设 `localhost:PORT`

### 五感架构表

| 能力 | 模块 | 依赖 |
|------|------|------|
| 令牌派生 | `dao_kernel.js::DaoIdentity.serviceToken()` | 纯 Node crypto (Ed25519) |
| LAN 发现 | `remote-agent/dao_rendezvous.js` | 纯 Node dgram (UDP 多播) |
| NAT 穿透 | `remote-agent/dao_nat.js` | 纯 Node dgram+http (SSDP+SOAP / NAT-PMP) |
| QR 配对 | `remote-agent/dao_pair.js` | 纯 Node crypto+zlib (Reed-Solomon 手写) |

**无一个新 npm 依赖**。

## 环境变量（全部可选 · 所有字段都有确定性涌现路径）

| 变量 | 涌现路径 | 说明 |
|------|--------|------|
| `PORT` | 3002 → EADDRINUSE 自动 +1 重试 | Hub 首选端口 |
| `SCRCPY_HUB_PORT` / `MJPEG_PORT` / `INPUT_PORT` / `GHOST_SHELL_PORT` / `DAO_REMOTE_PORT` / `ADB_HUB_PORT` / `SUNLOGIN_PORT` | 各自传统默认 → registry `portCandidates` 自动探测 | 各投屏/输入源首选端口 |
| `ADB_HUB_TOKEN` | env → `~/.dao-remote/adb_hub.token` → `identity.serviceToken("adb_hub")` | **无字面量后备** |
| `PS_AGENT_MASTER_TOKEN` | env → 身份签发 7 天 Ed25519 JWT | |
| `PUBLIC_URL` | env → 隧道 URL → NAT 映射 URL → 请求自描述 | 不再预设 `localhost:PORT` |
| `NO_TUNNEL` | `0` | `1` 禁用 cloudflared/ngrok/SSH |
| `DAO_NO_NAT` | `0` | `1` 禁用 UPnP IGD / NAT-PMP 自穿 |
| `DAO_LAN_ONLY` | `0` | `1` 两仪不出门 — 等价 `NO_TUNNEL=1 + DAO_NO_NAT=1` |
| `DAO_NO_BROWSER` | `0` | `1` 禁用启动后自开浏览器 |
| `DAO_NO_MDNS` | `0` | `1` 禁用 `dao-<fp8>.local` mDNS 广播 |

> 详见 `.env.example`

## CLI 参数

```bash
node dao.js [选项]
```

| 选项 | 等价 env | 说明 |
|------|----------|------|
| `--lan-only` | `DAO_LAN_ONLY=1` | 不穿 NAT 不开隧道, 纯局域网 |
| `--no-tunnel` | `NO_TUNNEL=1` | 禁 cloudflared/ngrok/SSH |
| `--no-nat` | `DAO_NO_NAT=1` | 禁 UPnP IGD / NAT-PMP |
| `--no-browser` | `DAO_NO_BROWSER=1` | 启动后不自动打开浏览器 |
| `--install` | — | 注册开机自启 (Windows schtasks / Linux systemd) |
| `--uninstall` | — | 注销开机自启 |
| `--service-status` | — | 查看自启状态 |

## 故障排查 (Troubleshooting)

**Windows 上 Python Relay 启动即 `PermissionError 10013`**
> 症状: `[relay!] PermissionError: [WinError 10013] 以一种访问权限不允许的方式...`
> 原因: Relay 分到的动态端口落在 Windows Hyper-V/WSL/winnat 保留区 (通常 49152-65535).
> 处理: **v8.7 已修** — `portSync()` 改用 20000-40000 用户区, Relay 改绑 `127.0.0.1`, 且 exit 非 0 时 dao.js 自动换口重启.
> 验证: `netsh int ipv4 show excludedportrange protocol=tcp` 可查本机排除列表.

**Hub 启动时 banner 打印两次**
> v8.6 及以下遇端口冲突触发递归 retry 时, `listening` 回调累积未清; **v8.7 已修**.

**Banner 误把 LAN IP 标为 "外网"**
> v8.6 及以下当 `PUBLIC_URL` 是 LAN IP 时仍打 "外网" 标签; **v8.7 已修** — 仅真实公网 URL 才标 "外网".

**Linux 上 `nvm: command not found`**
> `command -v nvm` 无法识别 shell function; **v8.7 install.sh 已修** — 先 `. $HOME/.nvm/nvm.sh` 再检测.

**Linux 上 `unzip: command not found`**
> **v8.7 已修** — 兜底 `bsdtar` / `jar xf`, 三选一即可解压.

**想只 LAN 用, 不要公网暴露**
> `node dao.js --lan-only` 或设 `DAO_LAN_ONLY=1`; 完全关闭 cloudflared + UPnP.

## 项目结构

```text
├── dao_crypto.js               # 密码学 — Ed25519/X25519/AES-256-GCM/令牌/速率限制
├── dao_kernel.js               # 道核 — 熵源/身份/发现/能力/会话/工具检测 (万物之源)
├── dao.js                      # 入口 — 道生一: 自动发现/启动 ghost_shell + Hub + Tunnel
├── bin/ghost_shell.exe          # 投屏引擎 — Go原生GDI+SendInput+WASAPI (30fps/零依赖)
├── remote-agent/               # WebSocket 中枢
│   ├── server.js              # 主服务: registry 驱动 discover/best/capture/input/proxy
│   ├── dao_screen_registry.js # 一表定万法 — 所有投屏/输入源的单一事实表
│   ├── page.js                # 前端: 投屏/触控/终端/诊断/系统信息
│   ├── dao_bridge.js          # Relay 自动发现桥接 (道核Token)
│   ├── dao_tunnel.js          # 自适应隧道 (cloudflared→ngrok→SSH)
│   └── brain.js               # CLI 交互工具
├── ps-agent/                   # HTTP Agent Relay (Python)
├── web/index.html              # 硬件诊断向导 (静态)
├── .env.example                # 环境配置模板
├── desktop_guardian.ps1        # 安全守护 (23诊断 + 14修复)
└── frpc.example.toml           # FRP 隧道模板 (可选)
```

## 核心函数

| 函数 | 位置 | 作用 |
|------|------|------|
| `ScreenRegistry.register()` | dao_screen_registry.js | 注册一行 → 自动参与 discover/best/capture/input/proxy |
| `captureScreenBest()` | server.js | 3 行: 委派 `_screenReg.captureBest()` + Agent 兜底 |
| `sendInputToDevice()` | server.js | 1 行: 委派 `_screenReg.inputBest()` |
| `discoverScreenSources()` | server.js | 1 行: 委派 `_screenReg.probeAll()` |
| `getBestScreenSource()` | server.js | 1 行: 委派 `_screenReg.best()` |
| `startGhostShell()` | dao.js | 自动发现/启动 ghost_shell.exe (Go原生30fps投屏引擎) |
| `getUnifiedAgentScript()` | server.js | 生成 PowerShell Agent: 多路径连接 + 屏幕推送 |
| `_probeRemoteTools()` | dao_kernel.js | 远程工具自动检测: 扫描7种启动器(FS+进程) |

## License

MIT
