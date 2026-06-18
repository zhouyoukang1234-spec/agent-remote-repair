# AGENTS.md — AI Agent 操作指南

## 项目性质
三明治远程中枢：操控端(云/本地 Agent) → 中枢(本进程+出站隧道) → 被控端(任意机器一行 PowerShell)。
**最终产出 = 一个 VS Code 类编辑器扩展**（VS Code/Cursor/Windsurf/VSCodium 通用）：激活即中枢=本编辑器，去中心化、零配置、零费用。CLI(`node dao.js`)为同源孪生。

## 关键文件
| 文件 | 用途 |
|------|------|
| `extension.js` | **最终产出**：VS Code 类编辑器扩展（激活=中枢、状态栏、中枢状态台 Webview、8 命令）|
| `core.js` | 本源核心：Hub(注册表+队列/轮询/结果+agent_id 路由) + 统一路由 + HTTP server + relay 桥 + `/api/bootstrap.ps1` |
| `tunnel.js` | 出站隧道（cloudflared/ngrok/SSH 自适应）|
| `dao.js` | CLI 孪生：`node dao.js` 起 server + 隧道 + 打印接入文档（与扩展同源 core）|

## Agent 规则
1. **操控端只认 REST**：`POST /api/exec-sync {agent_id,cmd}`。`agent_id` 空 = 中枢本机；填 hostname/别名 = 对应被控端。
2. **被控端零安装**：目标机 `irm <中枢URL>/api/bootstrap.ps1 | iex` 即接入；窗口不关 = 常驻可控。
3. **先看 agents 再下发**：`GET /api/agents` 确认目标在线。
4. **master token 必带**：除 `/api/health` 与 `/api/bootstrap.ps1` 外，操控端端点都要 `Authorization: Bearer <Token>`。

## 自检
`npm test` — 三明治端到端契约（无需外网）。
