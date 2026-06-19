# 道 · 远程中枢 (Agent Remote Repair) v9

> 反者道之动 · 大道至简 · 零成本 · 零配置 · 零注册
>
> 以内网穿透 **dao-bridge** 插件核心为本源，延伸出**三明治架构**：
> 一台机器跑中枢，任意机器一行 PowerShell 即被控，云端/本地 Agent 共用一套 REST 操控一切。

```
操控端 (你 / 云端·本地 Devin Agent, REST)
        │  POST /api/exec-sync {agent_id, cmd}      ← agent_id 选目标，空=中枢自己
        ▼
中枢 (编辑器插件 + 出站隧道 = 唯一公网入口)          ← VS Code 扩展（CLI: node dao.js 为同源孪生）
        │  命令队列 + 长轮询 + 结果回填
        ▼
被控端 (任意机器, 一行 PowerShell)                  ← irm <隧道>/api/bootstrap.ps1 | iex
```

## 安装（VS Code 类编辑器 — 最终产出 · 去中心化）

本仓库以**这一个扩展**为核心产出。只用标准 VS Code 扩展 API，**任意 VS Code 类编辑器**皆可无缝使用：VS Code、Cursor、Windsurf、VSCodium、code-server 等（`engines.vscode ^1.74.0`）。

**① 直接下载（推荐）**：到 [Releases](https://github.com/zhouyoukang1234-spec/agent-remote-repair/releases) 下载最新 `agent-remote-repair-*.vsix`。

**② 自行打包**：

```bash
npx @vscode/vsce package --allow-star-activation --no-dependencies   # 产出 .vsix
```

> 也可由 CI 自动产出：往 `main` 推代码即按 `package.json` 版本自动打包并发版到 [Releases](https://github.com/zhouyoukang1234-spec/agent-remote-repair/releases)（见下文「持续集成与自动发布」）。

在编辑器里 `Extensions: Install from VSIX…` 选择该 `.vsix` 即可。激活后**中枢=本编辑器**（去中心化：每个安装即自有中枢，默认零外部服务器），左侧活动栏出现 **DAO Bridge** 图标，命令面板搜 `DAO Bridge` 见 6 个命令（`daoBridgeHub.*`）。

> 命名空间统一为 `daoBridgeHub.*`（视图/命令/配置），与遗留 `dao-bridge` / `daoRemote` 插件标识不再重名，从根本上规避两插件并存时抢注同名命令/视图导致面板无法输入的冲突；激活时若探测到遗留同类插件会提示一键卸载。旧的 `daoBridge.*` / `daoRemote.*` 用户设置仍会自动回退读取，升级不丢配置。

点活动栏 **DAO Bridge** 图标打开 **「公网穿透」** 面板：一窗汇总本机/中枢状态 + **通过 PowerShell 接入的在线设备列表**（每 3s 实时刷新）+ **一行接入指令的复制按钮**（URL 随隧道就绪实时刷新）。每当有设备接入/掉线，`~/DAO_CLOUD_AGENT.md` 云端文档**自动重写**——内含所有在线设备（含中枢）与操控逻辑，复制给云端/本地 Agent 即可让其知悉全部在线设备并直接操控。

## 一行启动（CLI 孪生，可选）

### 中枢（操作端做中枢，本源端）

```bash
# 已有 Node.js
git clone https://github.com/zhouyoukang1234-spec/agent-remote-repair.git
cd agent-remote-repair && npm install && npm start
```

```powershell
# 小白一键（自动装 Node + 拉取 + 启动 + 公网隧道）
irm https://raw.githubusercontent.com/zhouyoukang1234-spec/agent-remote-repair/main/install.ps1 | iex
```

启动后终端会打印 **公网 URL + Token + 被控端一行命令**，并写入 `~/DAO_CLOUD_AGENT.md`（发给云端 Agent 即可接入）。

### 被控端（任意 Windows 机器，一行接入）

```powershell
irm <中枢公网URL>/api/bootstrap.ps1 | iex
```

窗口不关 = 一直可被操控。接入后中枢 `GET /api/agents` 即可看到它。

## 为什么"一行 PowerShell"就能接入并被完全操控

这正是本源 dao-bridge / 公网 PowerShell Agent 的"道"，拆成四条底层事实：

1. **被控端只做"出站" HTTP**（connect/poll/result）。NAT、家用路由器、公司防火墙默认放行出站、拦截入站 → **无需公网 IP、无需端口转发、无需改路由器**。中枢只是一个公网**会合点**，被控端自己连上来。
2. **长轮询 = 伪推送**：`/api/poll` 在中枢挂起请求直到有命令入队或超时（事件唤醒，延迟极低）。
3. **`cmd_id` 关联请求↔结果**：`/api/exec-sync` 入队后阻塞等 `results[cmd_id]`，把异步队列伪装成同步调用。
4. **`irm | iex`** 把"注册 + 长轮询 + 执行 + 回写"整段循环注入当前 PowerShell 会话，`Invoke-Expression` 执行任意命令 → PowerShell 即全机操控面。

> 出站长轮询解决"连得上"，cmd_id 关联解决"叫得动"，Invoke-Expression 解决"做得了"。三者合一 = 一行接入、全权操控。

## 操控端 API（需 `Authorization: Bearer <Token>`）

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| GET  | `/api/health` | - | 存活（免鉴权）|
| GET  | `/api/info` | - | 中枢信息 |
| GET  | `/api/agents` | - | 在线被控端列表 |
| POST | `/api/exec` | `{agent_id,type?,cmd?,file?,args?,cwd?,...}` | 异步下发，返回 `cmd_id` |
| GET  | `/api/result` | `?agent_id=&cmd_id=` | 取异步结果：`completed`+`result` 或 `pending` |
| POST | `/api/exec-sync` | `{agent_id,type?,cmd?,file?,args?,cwd?,timeout}` | 同步执行并等结果。`agent_id` 空/`self`/`local`/本机名 = **中枢自己这台** |
| POST | `/api/broadcast` | `{cmd}` | 广播到所有被控端 |
| POST | `/api/ls` `/api/read` `/api/write` | `{path,...}` | 中枢机文件操作（全机，修复中枢用）|
| GET  | `/api/bootstrap.ps1` | - | 被控端一行接入脚本（免鉴权，动态注入当前隧道 URL）|

被控端端点（被控端自己用 per-agent token 自证，不需要 master token）：
`POST /api/connect` → `GET /api/poll?id=&token=&timeout=` → `POST /api/result` / `POST /api/heartbeat`。

## 远程运行 `.bat`/`.cmd`/`.exe` / 任意程序（覆盖整机）

`/api/exec` 与 `/api/exec-sync` 除了裸 `cmd` 字符串，还支持 `type` 字段把请求规范化为一条健壮的 PowerShell 表达式（中枢本机与被控端**同源**执行）。根因修复：裸命令走 `Invoke-Expression`/`powershell -Command` 时，一个含空格的 `.bat`/`.exe` 路径会被当成**字符串字面量**或被拆词而跑不起来；本扩展用调用运算符 `&` + 单引号量化彻底规避。

| `type` | 行为 | 关键字段 |
|---|---|---|
| `shell`（默认）| 原样命令，向后兼容 | `cmd` |
| `run` / `file` | 运行 `.bat`/`.cmd`/`.exe`/`.ps1` + 参数，含空格路径安全，**透传原生退出码** | `file`, `args[]` |
| `cmd` / `bat` | 经 `cmd.exe /d /c` + `chcp 65001`（中文 UTF-8）跑批处理/经典 DOS | `cmd` |
| `detached` / `spawn` | `Start-Process -PassThru` 后台/GUI 启动，立即回 PID | `file`, `args[]`, `elevate?`, `show?` |

任意类型都可带 `cwd`（工作目录，覆盖整机任意路径）。裸 `file`（无 `cmd`）自动视为 `run`。

```jsonc
// 运行带空格路径的 .bat + 参数，拿原生退出码
POST /api/exec-sync  {"agent_id":"MY-PC","type":"run","file":"C:/Program Files/tool/build.bat","args":["release"]}
// 批处理 / 经典 DOS（UTF-8 中文回传）
POST /api/exec-sync  {"agent_id":"MY-PC","type":"cmd","cmd":"ipconfig /all"}
// 后台启动 GUI / 长驻进程，立即回 PID（可提权）
POST /api/exec-sync  {"agent_id":"MY-PC","type":"detached","file":"C:/Windows/notepad.exe","elevate":true}
```

被控端 `capabilities` 随之上报 `["shell","cmd","run","detached"]`。新表达式经现有 `Invoke-Expression $c.payload.command` 执行，**已部署的被控端无需重装即可获益**（只需中枢升级）。

## Python SDK（操控端）

```python
import urllib.request, json
URL="<中枢公网URL>"; TOKEN="<Token>"
def api(m,p,body=None,t=40):
    d=json.dumps(body).encode() if body else None
    req=urllib.request.Request(f"{URL}{p}",data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=m)
    return json.loads(urllib.request.urlopen(req,timeout=t).read())
print(api("GET","/api/agents"))
print(api("POST","/api/exec-sync",{"agent_id":"<被控端主机名>","cmd":"hostname"}))
print(api("POST","/api/exec-sync",{"agent_id":"","cmd":"whoami"}))   # 中枢本机
```

## CLI / 环境变量

| 标志 / 变量 | 作用 |
|---|---|
| `--port 3002` / `PORT` | 中枢端口（被占用自动 +1）|
| `--no-tunnel` / `NO_TUNNEL=1` | 禁用公网隧道 |
| `--lan-only` / `DAO_LAN_ONLY=1` | 仅局域网 |
| `DAO_TOKEN` | 指定 master token（默认随机并持久化到 `~/.dao-remote/conn.json`）|
| `DAO_RELAY_URL` | 走 Worker+DurableObject 稳定隧道（`*.workers.dev`），否则默认 cloudflared 透明隧道 |
| `DAO_ALIASES` | 被控端短名映射（软编码，无写死值），如 `{"laptop":"MY-PC"}` |

## 架构与源码

| 文件 | 角色 |
|---|---|
| `extension.js` | **最终产出** — VS Code 类编辑器扩展：激活即中枢=本编辑器，状态栏 + 中枢状态台(Webview，实时刷新设备列表+复制接入指令) + 6 命令(`daoBridgeHub.*`)，零中心、零配置 |
| `core.js` | **本源核心** — Hub（agent 注册表 + 队列/轮询/结果 + agent_id 路由）、统一路由、本机 HTTP server、relay 桥、`/api/bootstrap.ps1` |
| `tunnel.js` | 出站隧道（cloudflared → ngrok → SSH 自适应，自动下载，零配置）|
| `dao.js` | 极简 CLI 孪生 — `node dao.js` 起 server + 隧道 + 打印/落盘接入文档（与扩展同源 core）|

## 源流 · 取之精之（正本清源）

本仓库是内网穿透 **dao-bridge** 多模块原型的**蒸馏产物**：只取其「道」——出站长轮询 + `cmd_id` 关联 + 一行 `irm|iex` 接入——沉淀进 `core.js` / `tunnel.js`，由 `extension.js` 收口为**单一编辑器插件**。原型中的 mDNS / NAT 打洞 / 配对 / 网络唤醒 / 录屏 / Web 面板 / Python 端等枝节一律**去芜存清**，需要时再按需生长。少则得，大道至简。

## 自检

```bash
npm test     # 三明治端到端契约：操控端 → 中枢 → 被控端(模拟) 全链路，无需外网
```

## 持续集成与自动发布

仓库内置三条 GitHub Actions 工作流（`.github/workflows/`），把「测试 → 合并 → 发版」全自动化，鉴权全用内置 `GITHUB_TOKEN`、跑在 GitHub 原生环境：

| 工作流 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | 每个 PR / push 到 `main` | 在 **windows-latest** 跑 `npm test`（含真实 `.bat` 实跑、原生退出码、命名空间共存防冲突），给出 `test` 状态检查 |
| `auto-merge.yml` | CI 跑完(`workflow_run`)、PR 开/更/重开/转就绪、手动、每 30 分钟定时 | 自动合并 **base=main、非草稿、同仓库、无冲突且 CI 通过** 的 PR；有冲突/失败的留待人工。合并后显式 dispatch `release.yml` |
| `release.yml` | push 到 `main`（命中代码/版本/CHANGELOG）或手动 | 先跑测试 → `vsce` 打 VSIX → 按 `package.json` 版本建 GitHub Release（附 VSIX + 取自 `CHANGELOG.md` 的发布说明）；同名 tag 已存在则**幂等跳过** |

要发新版：在 PR 里改好代码并**提升 `package.json` 的 `version`**、在 `CHANGELOG.md` 新增对应小节即可——合并到 `main` 后自动产出该版本的 Release。

## 安全

- master token 经 `Bearer` 鉴权，把守一切操控/文件端点；被控端用各自的 per-agent token 自证。
- `exec` = 任意命令 = 完全控制：务必保护好公网 URL 与 Token；建议用稳定 relay + 强 token。
- 中枢只做**出站**连接，不开任何入站端口到公网。

*道法自然 · 无为而无不为*
