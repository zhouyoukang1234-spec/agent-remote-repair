# 道 · 远程中枢 (Agent Remote Repair) v9

> 反者道之动 · 大道至简 · 零成本 · 零配置 · 零注册
>
> 以内网穿透 **dao-bridge** 插件核心为本源，延伸出**三明治架构**：
> 一台机器跑中枢，任意机器一行 PowerShell 即被控，云端/本地 Agent 共用一套 REST 操控一切。

```
操控端 (你 / 云端·本地 Devin Agent, REST)
        │  POST /api/exec-sync {agent_id, cmd}      ← agent_id 选目标，空=中枢自己
        ▼
中枢 (本进程 + 出站隧道 = 唯一公网入口)              ← node dao.js
        │  命令队列 + 长轮询 + 结果回填
        ▼
被控端 (任意机器, 一行 PowerShell)                  ← irm <隧道>/api/bootstrap.ps1 | iex
```

## 安装（VS Code 类编辑器 — 最终产出 · 去中心化）

本仓库以**这一个扩展**为核心产出。只用标准 VS Code 扩展 API，**任意 VS Code 类编辑器**皆可无缝使用：VS Code、Cursor、Windsurf、VSCodium、code-server 等（`engines.vscode ^1.74.0`）。

```bash
npx @vscode/vsce package          # 产出 .vsix
```

在编辑器里 `Extensions: Install from VSIX…` 选择该 `.vsix` 即可。激活后**中枢=本编辑器**（去中心化：每个安装即自有中枢，默认零外部服务器），状态栏显示 `本地:<port> · N 被控端`，命令面板搜 `DAO` 见 8 个命令。被控端短名映射用设置 `daoRemote.aliases`（软编码，无写死值）。

点状态栏（或命令 `DAO 远程中枢: 打开中枢状态台`）打开 **「DAO 中枢状态台」**：一窗汇总本机/中枢状态 + **通过 PowerShell 接入的在线设备列表**（每 3s 实时刷新）+ **一行接入指令的复制按钮**（URL 随隧道就绪实时刷新）。每当有设备接入/掉线，`~/DAO_CLOUD_AGENT.md` 云端文档**自动重写**——内含所有在线设备（含中枢）与操控逻辑，复制给云端/本地 Agent 即可让其知悉全部在线设备并直接操控。

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
| POST | `/api/exec` | `{agent_id,cmd}` | 异步下发，返回 `cmd_id` |
| GET  | `/api/result` | `?agent_id=&cmd_id=` | 取异步结果：`completed`+`result` 或 `pending` |
| POST | `/api/exec-sync` | `{agent_id,cmd,timeout}` | 同步执行并等结果。`agent_id` 空/`self`/`local`/本机名 = **中枢自己这台** |
| POST | `/api/broadcast` | `{cmd}` | 广播到所有被控端 |
| POST | `/api/ls` `/api/read` `/api/write` | `{path,...}` | 中枢机文件操作（全机，修复中枢用）|
| GET  | `/api/bootstrap.ps1` | - | 被控端一行接入脚本（免鉴权，动态注入当前隧道 URL）|

被控端端点（被控端自己用 per-agent token 自证，不需要 master token）：
`POST /api/connect` → `GET /api/poll?id=&token=&timeout=` → `POST /api/result` / `POST /api/heartbeat`。

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
| `DAO_ALIASES` | 被控端短名映射（软编码，无写死值），如 `{"laptop":"MY-PC"}`；插件内亦可用设置 `daoRemote.aliases` |

## 架构与源码

| 文件 | 角色 |
|---|---|
| `extension.js` | **最终产出** — VS Code 类编辑器扩展：激活即中枢=本编辑器，状态栏 + 中枢状态台(Webview，实时刷新设备列表+复制接入指令) + 8 命令，零中心、零配置 |
| `core.js` | **本源核心** — Hub（agent 注册表 + 队列/轮询/结果 + agent_id 路由）、统一路由、本机 HTTP server、relay 桥、`/api/bootstrap.ps1` |
| `tunnel.js` | 出站隧道（cloudflared → ngrok → SSH 自适应，自动下载，零配置）|
| `dao.js` | 极简 CLI 孪生 — `node dao.js` 起 server + 隧道 + 打印/落盘接入文档（与扩展同源 core）|

## 自检

```bash
npm test     # 三明治端到端契约：操控端 → 中枢 → 被控端(模拟) 全链路，无需外网
```

## 安全

- master token 经 `Bearer` 鉴权，把守一切操控/文件端点；被控端用各自的 per-agent token 自证。
- `exec` = 任意命令 = 完全控制：务必保护好公网 URL 与 Token；建议用稳定 relay + 强 token。
- 中枢只做**出站**连接，不开任何入站端口到公网。

*道法自然 · 无为而无不为*
