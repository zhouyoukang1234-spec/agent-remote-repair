# 更新日志

本项目遵循语义化版本。日期格式 YYYY-MM-DD。

## [9.0.1] - 2026-06-18

修复「装进真实 VS Code 后看不到任何前端」的可用性问题。

### 新增
- **活动栏常驻视图**：新增左侧活动栏图标「DAO 远程中枢」+ 侧边 WebviewView「中枢状态台」，**装好插件即可见的前端**——点图标即见中枢状态/在线设备/一行接入指令复制按钮，无需先开命令面板。
- 状态台新增「重启中枢」按钮，启动失败可一键重试。

### 修复
- **激活不再阻塞于中枢启动**：状态栏与侧栏视图在 `activate` 时立即渲染（先显示"未启动"），中枢在后台启动；即使 `startServer`/隧道失败或卡住，前端也始终可见，并弹出明确错误提示，可一键重启（此前若 `startServer` 拒绝/挂起，UI 完全不显示）。

## [9.0.0] - 2026-06-18

正本清源：仓库收口为**单一 VS Code 类编辑器插件**。在 dao-bridge 内网穿透核心之上，
延伸出"三明治架构"——任意公网设备一行 PowerShell 即接入同一中枢，云端/本地 Agent 共用一套 REST 全方位操控一切。

### 新增
- **中枢=本编辑器**：插件激活即在编辑器内起 HTTP 中枢 + 出站隧道，去中心化、零配置、零费用。
- **「DAO 中枢状态台」Webview 面板**（命令 `daoRemote.showPanel`）：本机/中枢状态 + 通过 PowerShell 接入的在线设备列表，每 3s 实时刷新；顶部一行接入指令复制按钮，URL 随隧道就绪刷新。
- **云端接入文档自动刷新**：设备接入/掉线/隧道就绪时自动重写 `~/DAO_CLOUD_AGENT.md`（含全部在线设备 + 操控逻辑），复制给 Agent 即可知悉并操控全部在线设备。
- **软编码别名**：被控端短名→主机名映射经设置 `daoRemote.aliases` 或环境变量 `DAO_ALIASES`，无任何写死值。
- **全 VS Code 类编辑器适配**：`engines.vscode ^1.74.0`，仅用标准 API，兼容 VS Code / Cursor / Windsurf / VSCodium / code-server。
- CLI 同源孪生 `node dao.js`（可选），一键安装脚本 `install.ps1` / `install.sh`。

### 修复
- SELF（操控中枢本机）路径强制 UTF-8 输出，修正中文/非 ASCII 变 `?`。
- SELF 路径透传原生进程退出码（`exit $LASTEXITCODE`），与被控端语义同源。

### 移除（去芜存清）
- 删除原全量原型：`remote-agent/`（server/brain/mdns/nat/pair/wol/recorder 等）、`ps-agent/`、`web/`、`docs/`、`dao_kernel.js`/`dao_crypto.js`/`dao_sunlogin.js`/`desktop_guardian.ps1`/`frpc.example.toml` 等，净删约 1.9 万行。

### 核心文件
- `extension.js` — 最终产物（编辑器扩展）
- `core.js` — 本源核心（Hub 注册表/队列/长轮询/结果 + agent_id 路由 + `/api/bootstrap.ps1` + relay 桥）
- `tunnel.js` — 出站隧道（cloudflared / ngrok / SSH 自适应）
- `dao.js` — 同源 CLI 孪生

测试：`npm test` 32/32 通过。
