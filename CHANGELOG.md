# 更新日志

本项目遵循语义化版本。日期格式 YYYY-MM-DD。

## [9.4.0] - 2026-06-18

从根本底层完善执行模块 —— 让被控端与中枢本机都能远程跑 `.bat`/`.cmd`/`.exe` 及任意程序，覆盖整台电脑。

### 根因
此前 exec 把命令原样交给 `Invoke-Expression`（被控端）/ `powershell -Command`（中枢本机）。在 PowerShell 里，一个 `.bat`/`.exe` 文件路径（尤其含空格）会被当成**字符串字面量**而非**可执行**——直接发文件路径只会回显路径、跑不起来，这正是"用 dao bridge 远程跑不了 bat"的根因。命令类型也只有 `shell`/`sysinfo` 两种，没有运行文件、批处理、后台进程的语义。

### 完善（统一 exec 规范化）
- **新增 `buildExecCommand()`**：把高层 exec 请求规范化为一条健壮的 PowerShell 表达式，中枢本机与被控端**同一条命令**执行；用调用运算符 `&` + 单引号量化，彻底规避 `.bat`/`.exe` 路径与空格问题。
- **新命令类型**（向后兼容，默认仍 `shell`）：
  - `run`/`file` — 运行某个文件（`.bat`/`.cmd`/`.exe`/`.ps1`…）+ `args` 数组，`& '<file>' '<arg>'…` 直接执行带空格路径，透传原生退出码。
  - `cmd`/`bat` — 经 `cmd.exe /d /c` 执行（前置 `chcp 65001` 保证中文 UTF-8 回传），跑批处理/经典 DOS 命令。
  - `detached`/`spawn` — `Start-Process -PassThru` 后台/分离启动（GUI 或长驻进程，不阻塞轮询循环），立即回 PID；可选 `elevate`(管理员提权)、`show`(显示窗口)。
  - 裸 `file` 字段（无 `cmd`）自动视为 `run`。
- **可选 `cwd`**：任意类型都可带工作目录（`Set-Location -LiteralPath`），覆盖整机任意路径。
- **被控端能力上报**：bootstrap 一行接入脚本 `capabilities` 升级为 `shell,cmd,run,detached`；新表达式经现有 `Invoke-Expression $c.payload.command` 执行，**已部署的被控端无需重装即可获益**（只需中枢升级）。
- **同步至两处实现**：headless 后端 `core.js`（`dao.js` 用）与 VS Code 插件 `extension.js`（用户实际中枢）一致改造。

### 权限说明
被控端/中枢以**启动它的用户身份**运行（管理员启动即管理员权限），文件接口 `/api/ls`·`/api/read`·`/api/write` 本就覆盖整机（不限工作区）；本版补齐的是命令**派发语义**，使整机任意可执行/批处理/程序皆可远程驱动。

测试：`npm test` 63/63（31 core + 32 ext），含中枢本机**真实 `.bat` 实跑 + 原生退出码**、`cmd` 类型 UTF-8 回传、`run`/`detached` 表达式构造与端到端路由。

### 工程化（CI / 自动化 PR / 自动发布）
- **`ci.yml`**：每个 PR / push 到 `main` 在 **windows-latest** 跑 `npm test`（含真实 `.bat` 实跑），给出 `test` 状态检查。
- **`auto-merge.yml`**：CI 跑完（`workflow_run`）或 PR 开/更/重开/转就绪/定时扫描时，自动合并 **base=main、非草稿、同仓库、无冲突且 CI 通过** 的 PR；合并后显式 dispatch `release.yml`。
- **`release.yml`**：push 到 `main`（命中代码/版本/CHANGELOG）或手动触发时，先跑测试 → `vsce` 打 VSIX → 按 `package.json` 版本建 GitHub Release（附 VSIX + 取自 `CHANGELOG.md` 的发布说明），同名 tag 已存在则幂等跳过。
- README 补全：新增「远程运行 `.bat`/`.cmd`/`.exe`」exec 类型表与示例、「持续集成与自动发布」一节；修正命令数（6 个 `daoBridgeHub.*`）与打包命令参数。

## [9.3.0] - 2026-06-18

从根本底层规避一切插件并存冲突。此前合并自本源 dao-bridge 时，沿用了与遗留 `dao.dao-bridge` 插件**完全相同**的贡献标识（活动栏容器 `daoBridge` / 视图 `daoBridgeView` / 命令 `daoBridge.*`）。一旦两插件同时安装，二者抢注同一 `registerWebviewViewProvider("daoBridgeView")` 与同名命令，后注册者抛错中断激活 → webview 的 `onDidReceiveMessage` 没挂上 → 面板按钮点不动、输入框打不了字（"没法写字"）。

### 修复（彻底规避冲突）
- **唯一命名空间**：全部贡献标识迁至 `daoBridgeHub.*`（活动栏容器 `daoBridgeHub` / 视图 `daoBridgeHubView` / 命令 `daoBridgeHub.*` / 配置 `daoBridgeHub.*`），与遗留 `daoBridge`、`daoRemote` 永不重名——两插件并存也不再抢注同一 id。
- **配置回退**：`daoCfg()` 优先读新命名空间用户设置，否则回退历史 `daoBridge` / `daoRemote` 的显式设置，最后用新默认值——升级不丢用户既有配置。
- **防御式注册**：`activate` 内每项 `registerCommand`/`registerWebviewViewProvider` 都经 `safeReg` 包裹，任何残留同名插件/重复激活都不再 brick 掉 webview，消息处理器必然挂上、输入框永远可用。
- **遗留插件探测**：激活时扫描其它贡献 `daoBridge.*`/`daoRemote.*` 命令或同名视图的插件，弹窗提示并支持一键 `卸载遗留插件` + 重载窗口，从源头消除并存。
- **Webview 加固**：注入 CSP（`script-src 'nonce-…'`，脚本严格走 nonce 防 XSS）+ 事件委托（移除全部内联 `onclick`，改 `data-op`），确保任意编辑器/锁定环境下输入框与按钮都可用。

测试：`npm test` 48/48（20 core + 28 ext）；VS Code 1.125 扩展宿主实测面板可正常打字、与遗留插件并存无冲突。

## [9.2.0] - 2026-06-18

回归本源 · 在本源 dao-bridge 插件上演化，而非另起炉灶。以
[devin-remote](https://github.com/zhouyoukang1234-spec/devin-remote) 的 `dao-bridge-ext/extension.js`（1606 行）为不可变基底，
将「公网设备汇入单一中枢」的核心能力**嫁接**其上——前端、隧道生命周期、CF 登录/中继/命名隧道全部沿用本源，
仅做最小增量。

### 演化（在本源基础上增量）
- **三明治路由**：新增被控端端点 `/api/connect`、`/api/poll`（长轮询）、`/api/result`、`/api/heartbeat`（均以 per-agent token 自证，免 master token）；`/api/bootstrap.ps1` 免鉴权下发一行接入脚本。
- **exec / exec-sync 按 `agent_id` 路由**：留空/`self`/`local`/中枢主机名 → 中枢本机执行（本源 SELF·UTF-8+退出码）；填主机名 → 入队转发被控端，`exec-sync` 同步等回结果，`exec` 返回 `cmd_id`。`/api/broadcast` 入队所有被控端。
- **前端演化**：在本源 4 模块（实时状态 / 命名隧道 / 导出文档 / 能力自测）基础上，新增「📡 在线设备 · 汇入中枢」模块——一行接入指令复制按钮 + 在线设备表，3s 实时刷新。
- **云端 MD 演化**：`generateCloudAgentMd()` 新增「当前在线设备（中枢 + 被控端）」清单与一行接入指令，复制给 Agent 即知全部在线设备与按 `agent_id` 操控逻辑。
- **package.json 对齐本源**：`displayName = DAO Bridge · 公网穿透`，contributes 用本源 `daoBridge` 活动栏容器 / `daoBridgeView` 视图 / `daoBridge.*` 命令 / 完整配置项；新增 `daoBridge.copyBootstrap` 命令；保留我方仓库元数据与全 IDE 适配（`engines ^1.74.0`、capabilities）。

测试：`npm test` 42/42 通过（20 core + 22 ext）。

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
