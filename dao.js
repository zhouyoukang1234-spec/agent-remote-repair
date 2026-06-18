#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════╗
// ║  道 · 万法归宗 — 一切从这里开始                          ║
// ║                                                          ║
// ║      node dao.js                                         ║
// ║                                                          ║
// ║  本源 = dao-bridge 插件核心（本机 API + 出站隧道）        ║
// ║  延伸 = 多机板块（一行 PowerShell 接入的被控端中枢）      ║
// ║                                                          ║
// ║  三明治：操控端(云/本地 Devin) → 中枢(本进程+隧道) → 被控端║
// ║  大道至简 · 反者道之动 · 唯变所适                         ║
// ╚══════════════════════════════════════════════════════════╝
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { Hub, startServer, connectRelay } = require("./core");
const tunnel = require("./remote-agent/dao_tunnel");

const pkg = (() => {
  try {
    return require("./package.json");
  } catch {
    return { version: "0.0.0" };
  }
})();

// ── CLI / env（唯变所适：仅在显式指定时覆盖）──
const ARGV = process.argv.slice(2);
const LAN_ONLY = ARGV.includes("--lan-only") || process.env.DAO_LAN_ONLY === "1";
const NO_TUNNEL = LAN_ONLY || ARGV.includes("--no-tunnel") || process.env.NO_TUNNEL === "1";
function argVal(flag) {
  const i = ARGV.indexOf(flag);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : "";
}
const PORT = parseInt(argVal("--port") || process.env.PORT || "3002", 10);
const RELAY_URL = process.env.DAO_RELAY_URL || ""; // 设了则走 Worker+DO 稳定隧道

// ── 凭证持久化：token 跨重启稳定（操控端保存的 token 不失效）──
const CONN_DIR = path.join(os.homedir(), ".dao-remote");
const CONN_FILE = path.join(CONN_DIR, "conn.json");
function loadConn() {
  try {
    return JSON.parse(fs.readFileSync(CONN_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveConn(conn) {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    fs.writeFileSync(CONN_FILE, JSON.stringify(conn, null, 2), "utf8");
  } catch {}
}

const conn = loadConn();
const TOKEN = process.env.DAO_TOKEN || conn.token || crypto.randomBytes(24).toString("hex");
const SESSION = conn.session || crypto.randomBytes(16).toString("hex");

const hub = new Hub({ token: TOKEN, version: pkg.version, root: os.homedir() });

function exportDoc() {
  const url = hub.publicUrl || "http://<本机IP>:" + hub.port;
  const md = `# ☯ 道 · 云端 Agent 接入文档

> 道法自然 · 自动生成。把它发给云端/本地 Agent 即可操控本中枢与一切接入的被控端。

## 接入点

\`\`\`
URL:   ${url}
Token: ${hub.token}
Auth:  Authorization: Bearer <Token>
隧道:  ${hub.tunnelMethod || (NO_TUNNEL ? "lan-only" : "pending")}
\`\`\`

## 三明治架构

\`\`\`
操控端 (你/云端 Devin, REST)  ──agent_id 选目标──▶  中枢 (本机 ${hub.host} + 隧道)  ──▶  被控端 (任意机器, 一行 PowerShell)
\`\`\`

## 操控端 API（需 Bearer Token）

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| GET  | /api/health | - | 存活（免鉴权）|
| GET  | /api/info | - | 中枢信息 |
| GET  | /api/agents | - | 在线被控端列表 |
| POST | /api/exec-sync | {agent_id,cmd,timeout} | 同步执行（agent_id 空=中枢本机）|
| POST | /api/exec | {agent_id,cmd} | 异步下发 |
| POST | /api/broadcast | {cmd} | 广播到所有被控端 |
| POST | /api/ls / /api/read / /api/write | {path,...} | 中枢机文件操作 |
| GET  | /api/bootstrap.ps1 | - | 被控端一行接入脚本（免鉴权）|

## 被控端接入（任意 Windows 机器，一行）

\`\`\`powershell
irm ${url}/api/bootstrap.ps1 | iex
\`\`\`

接入后用 \`GET /api/agents\` 看到它，再 \`POST /api/exec-sync {agent_id:"<hostname>", cmd:"hostname"}\` 即可操控。

## Python SDK（操控端）

\`\`\`python
import urllib.request, json, ssl, os
for k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'): os.environ.pop(k,None)
os.environ['NO_PROXY']='*'
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx)))
URL=${JSON.stringify(url)}; TOKEN=${JSON.stringify(hub.token)}
def api(m,p,body=None,t=40):
    d=json.dumps(body).encode() if body else None
    req=urllib.request.Request(f"{URL}{p}",data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=m)
    return json.loads(urllib.request.urlopen(req,timeout=t).read())
print(api("GET","/api/agents"))
print(api("POST","/api/exec-sync",{"agent_id":"","cmd":"hostname"}))   # 中枢本机
\`\`\`

*道法自然 · 无为而无不为*
`;
  try {
    fs.writeFileSync(path.join(os.homedir(), "DAO_CLOUD_AGENT.md"), md, "utf8");
  } catch {}
  return md;
}

function banner() {
  const url = hub.publicUrl || "(隧道未就绪)";
  console.log("");
  console.log("  ╔══════════════════════════════════════════════╗");
  console.log("  ║  ☯ 道 · 远程中枢  v" + pkg.version.padEnd(26) + "║");
  console.log("  ╚══════════════════════════════════════════════╝");
  console.log("  本机     : " + hub.host + "  (" + process.platform + ")");
  console.log("  本地      : http://127.0.0.1:" + hub.port);
  console.log("  公网 URL : " + url + (hub.tunnelMethod ? "  [" + hub.tunnelMethod + "]" : ""));
  console.log("  Token    : " + hub.token);
  console.log("  接入文档 : " + path.join(os.homedir(), "DAO_CLOUD_AGENT.md"));
  console.log("");
  console.log("  被控端一行接入 (任意 Windows 机器):");
  console.log("    irm " + (hub.publicUrl ? hub.publicUrl : "http://<本机IP>:" + hub.port) + "/api/bootstrap.ps1 | iex");
  console.log("");
}

(async function main() {
  await startServer(hub, { port: PORT, bind: "0.0.0.0" });
  saveConn({ token: hub.token, session: SESSION, port: hub.port, updated: new Date().toISOString() });

  // 出站隧道 — 反者道之动：本机主动出站到公网会合点
  if (!NO_TUNNEL) {
    if (RELAY_URL) {
      hub.tunnelMethod = "relay";
      connectRelay(hub, { relayUrl: RELAY_URL, sessionId: SESSION, token: hub.token });
      setTimeout(() => {
        exportDoc();
        banner();
      }, 2500);
    } else {
      tunnel.onUrl((u) => {
        hub.publicUrl = u;
        hub.tunnelMethod = tunnel.method || "cloudflared";
        exportDoc();
        banner();
      });
      tunnel.start(hub.port);
      // 隧道未就绪也先出本地横幅
      setTimeout(() => {
        if (!hub.publicUrl) {
          exportDoc();
          banner();
        }
      }, 1500);
    }
  } else {
    hub.tunnelMethod = "lan-only";
    exportDoc();
    banner();
  }
})().catch((e) => {
  console.error("[dao] fatal:", e && e.message ? e.message : e);
  process.exit(1);
});

process.on("SIGINT", () => {
  try {
    tunnel.stop();
  } catch {}
  process.exit(0);
});
