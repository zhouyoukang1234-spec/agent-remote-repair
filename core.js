"use strict";
// ═══════════════════════════════════════════════════════════
// 道 · core — 反者道之动 · 大道至简
//
// 本源 = dao-bridge 插件核心：本机 HTTP API + 出站隧道。
// 延伸 = 多机板块：把"穿透它自己这一台"升级为"穿透任意一台只跑一行
//        PowerShell 的机器"——命令队列 + 长轮询 + agent_id 路由 + /bootstrap。
//
// 三明治：
//   操控端(云/本地 Devin，REST，多带 agent_id)
//     → 中枢(本模块 + 隧道，唯一公网入口)
//       → 被控端(任意机器，一行 PowerShell：irm <hub>/api/bootstrap.ps1 | iex)
//
// 纯 Node + stdlib（relay 桥可选依赖 ws）。无 vscode 依赖 → 独立后端与
// 任意宿主（含未来 VSIX）共用本源。
// ═══════════════════════════════════════════════════════════

const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";

// ── 本机执行任意命令（被控端模型在"中枢自己这台"上的等价实现）──
// Windows 下与 bootstrap 被控端同源语义：
//   ① 强制 UTF-8 输出编码 — 否则 powershell.exe 默认按 OEM 码页写管道，
//      中文/非 ASCII 输出全成 "?"（中文 Windows 操控本机的本源场景必坏）。
//   ② 退出码透传 — `powershell -Command` 默认只返回 0/1，吞掉原生进程退出码；
//      故末尾按 $LASTEXITCODE(原生码优先) → $Error(cmdlet 非终止错误=1) → 0 显式 exit。
function wrapPwshForUtf8AndExit(cmd) {
  return (
    "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
    "$ErrorActionPreference='Continue'; $Error.Clear(); $global:LASTEXITCODE=0\n" +
    cmd +
    "\n$__c=0; if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){$__c=$LASTEXITCODE} elseif($Error.Count -gt 0){$__c=1}; exit $__c"
  );
}

function runShell(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const shell = IS_WIN ? "powershell.exe" : "/bin/sh";
    const args = IS_WIN
      ? ["-NoProfile", "-Command", wrapPwshForUtf8AndExit(cmd)]
      : ["-c", cmd];
    execFile(
      shell,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || (err && err.killed ? "timeout" : ""),
          exit_code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        });
      },
    );
  });
}

function bearer(headers) {
  const h = headers["authorization"] || headers["Authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// ═══════════════════════════════════════════════════════════
// Hub — 持有 agent 注册表 + 每 agent 命令队列/结果表/唤醒器
// ═══════════════════════════════════════════════════════════

class Hub {
  constructor(opts) {
    opts = opts || {};
    this.token = opts.token || crypto.randomBytes(24).toString("hex");
    this.root = opts.root || os.homedir();
    this.host = os.hostname();
    this.startedAt = Date.now();
    this.publicUrl = "";
    this.tunnelMethod = "";
    this.version = opts.version || "1.0.0";
    this.agents = new Map(); // id -> AgentInfo
    // 别名：人记得住的短名 → 真 hostname。纯配置驱动，无任何写死值。
    //   优先级：opts.aliases(IDE 设置) > DAO_ALIASES(env)。键名大小写不敏感。
    this.aliases = {};
    const addAliases = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const k of Object.keys(obj)) this.aliases[String(k).toLowerCase().trim()] = obj[k];
    };
    addAliases(safeJson(process.env.DAO_ALIASES));
    addAliases(opts.aliases);
    this.HEARTBEAT_TIMEOUT = 120 * 1000;
    this.POLL_MAX = 28; // < cloudflared/relay 单连超时，留余量
  }

  resolveAlias(name) {
    if (!name) return "";
    const k = String(name).toLowerCase().trim();
    return this.aliases[k] || name;
  }

  // 被控端登记（开放：被控端"主动献出自己"，登记本身不授予任何操控权）
  register(sysinfo) {
    sysinfo = sysinfo || {};
    const id = sysinfo.hostname || "agent-" + crypto.randomBytes(3).toString("hex");
    const token = crypto.randomBytes(24).toString("hex");
    const existing = this.agents.get(id);
    if (existing) {
      existing.token = token;
      existing.sysinfo = sysinfo;
      existing.lastSeen = Date.now();
      existing.status = "online";
      return existing;
    }
    const a = {
      id,
      token,
      sysinfo,
      hostname: sysinfo.hostname || id,
      capabilities: sysinfo.capabilities || ["shell"],
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      status: "online",
      queue: [],
      waiters: [], // poll 等待者
      results: new Map(), // cmd_id -> result
      resultWaiters: new Map(), // cmd_id -> resolve（exec-sync 等待者）
    };
    this.agents.set(id, a);
    return a;
  }

  getAgent(id) {
    if (!id) return null;
    const a = this.agents.get(id);
    if (a) return a;
    const target = String(id).toLowerCase();
    for (const [, v] of this.agents) if (v.id.toLowerCase() === target) return v;
    return null;
  }

  agentAlive(a) {
    return Date.now() - a.lastSeen < this.HEARTBEAT_TIMEOUT;
  }

  // 操控端下发 → 入队并唤醒该 agent 的长轮询
  queueCommand(agentId, type, payload) {
    const a = this.getAgent(this.resolveAlias(agentId));
    if (!a) return { err: "agent not found" };
    const cmdId = "cmd_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
    a.queue.push({ cmd_id: cmdId, type: type || "shell", payload: payload || {} });
    const w = a.waiters.shift();
    if (w) w();
    return { cmdId, agent: a };
  }

  // 被控端长轮询：有命令即返回，否则挂起到超时
  pollCommands(a, timeoutSec) {
    a.lastSeen = Date.now();
    a.status = "online";
    const ms = Math.min(timeoutSec || this.POLL_MAX, this.POLL_MAX) * 1000;
    return new Promise((resolve) => {
      if (a.queue.length) return resolve(a.queue.splice(0));
      let done = false;
      const finish = (cmds) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = a.waiters.indexOf(wake);
        if (i >= 0) a.waiters.splice(i, 1);
        resolve(cmds);
      };
      const wake = () => finish(a.queue.splice(0));
      a.waiters.push(wake);
      const timer = setTimeout(() => finish([]), ms);
    });
  }

  submitResult(a, cmdId, result) {
    a.lastSeen = Date.now();
    a.results.set(cmdId, Object.assign({ completed_at: Date.now() }, result));
    if (a.results.size > 100) {
      const oldest = [...a.results.entries()].sort(
        (x, y) => (x[1].completed_at || 0) - (y[1].completed_at || 0),
      );
      for (let i = 0; i < a.results.size - 100; i++) a.results.delete(oldest[i][0]);
    }
    const w = a.resultWaiters.get(cmdId);
    if (w) w(a.results.get(cmdId));
  }

  // exec-sync：入队后阻塞等结果（伪同步）
  waitResult(a, cmdId, timeoutMs) {
    return new Promise((resolve) => {
      const existing = a.results.get(cmdId);
      if (existing) return resolve(existing);
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.resultWaiters.delete(cmdId);
        resolve(r);
      };
      a.resultWaiters.set(cmdId, finish);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  isSelf(agentId) {
    const k = String(agentId || "").toLowerCase().trim();
    return k === "" || k === "self" || k === "local" || k === this.host.toLowerCase();
  }

  agentList() {
    const out = [];
    for (const [id, a] of this.agents) {
      out.push({
        id,
        hostname: a.hostname,
        status: this.agentAlive(a) ? "online" : "offline",
        ip: a.sysinfo.public_ip || a.sysinfo.local_ip || "?",
        os: a.sysinfo.os_version || "?",
        user: a.sysinfo.username || "?",
        capabilities: a.capabilities,
        last_seen: new Date(a.lastSeen).toISOString(),
        pending: a.queue.length,
      });
    }
    return out;
  }

  info() {
    return {
      service: "dao-core",
      version: this.version,
      host: this.host,
      platform: process.platform + " " + os.release(),
      root: this.root,
      public_url: this.publicUrl,
      tunnel: this.tunnelMethod,
      agents_online: [...this.agents.values()].filter((a) => this.agentAlive(a)).length,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

function safeJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 统一路由 — HTTP 直连与 relay 信封共用
// ═══════════════════════════════════════════════════════════

async function handleRoute(hub, route, method, headers, query, bodyRaw) {
  let body = {};
  try {
    body = bodyRaw ? JSON.parse(bodyRaw) : {};
  } catch {
    body = {};
  }
  const q = query || {};
  const authed = !!hub.token && bearer(headers) === hub.token;

  // ── 公开端点 ──
  if (route === "/api/health") {
    return { status: 200, body: { status: "ok", service: "dao-core", version: hub.version, host: hub.host, agents_online: hub.agentList().filter((a) => a.status === "online").length, uptime: Math.floor((Date.now() - hub.startedAt) / 1000) } };
  }
  if (route === "/api/bootstrap.ps1" || route === "/bootstrap.ps1") {
    return { status: 200, contentType: "text/plain; charset=utf-8", raw: buildBootstrap(hub.publicUrl || ("http://127.0.0.1:" + hub.port)) };
  }

  // ── 被控端端点（以 per-agent token 自证，不需要 master token）──
  if (route === "/api/connect" && method === "POST") {
    const a = hub.register(body.sysinfo || body || {});
    return { status: 200, body: { agent_id: a.id, token: a.token, server_time: new Date().toISOString() } };
  }
  if (route === "/api/poll" && method === "GET") {
    const a = hub.getAgent(q.id);
    if (!a || a.token !== q.token) return { status: 401, body: { error: "unauthorized" } };
    const cmds = await hub.pollCommands(a, parseInt(q.timeout, 10) || hub.POLL_MAX);
    return { status: 200, body: { commands: cmds } };
  }
  if (route === "/api/result" && method === "POST") {
    const a = hub.getAgent(body.agent_id);
    if (!a || a.token !== body.token) return { status: 401, body: { error: "unauthorized" } };
    hub.submitResult(a, body.cmd_id, body.result || {});
    return { status: 200, body: { ok: true } };
  }
  if (route === "/api/heartbeat" && method === "POST") {
    const a = hub.getAgent(body.agent_id);
    if (a && a.token === body.token) {
      a.lastSeen = Date.now();
      a.status = "online";
    }
    return { status: 200, body: { ok: true } };
  }

  // ── 以下需 master token ──
  if (!authed) return { status: 401, body: { error: "unauthorized" } };

  if (route === "/api/info" && method === "GET") return { status: 200, body: hub.info() };
  if (route === "/api/agents" && method === "GET") return { status: 200, body: { agents: hub.agentList() } };

  // 操控端取异步结果：/api/exec 返回 cmd_id 后，凭此拉取（含 broadcast 各路结果）
  if (route === "/api/result" && method === "GET") {
    const a = hub.getAgent(hub.resolveAlias(q.agent_id));
    if (!a) return { status: 404, body: { error: "agent not found" } };
    const r = a.results.get(q.cmd_id);
    if (!r) return { status: 200, body: { status: "pending", agent_id: a.id, cmd_id: q.cmd_id } };
    return { status: 200, body: { status: "completed", agent_id: a.id, cmd_id: q.cmd_id, result: r } };
  }

  // 命令执行 — 按 agent_id 路由：self → 本机；否则 → 入队转发被控端
  if ((route === "/api/exec" || route === "/api/exec-sync") && method === "POST") {
    const sync = route === "/api/exec-sync";
    const cmd = body.cmd || body.command || (body.payload && body.payload.command) || "";
    const type = body.type || "shell";
    const timeoutMs = (Math.min(Number(body.timeout) || 60, 300)) * 1000;

    if (hub.isSelf(body.agent_id)) {
      // 中枢自己这一台（保持 dao-bridge 本源行为）
      if (!cmd) return { status: 400, body: { error: "cmd required" } };
      const r = await runShell(cmd, body.cwd || hub.root, timeoutMs);
      return sync ? { status: 200, body: { status: "completed", agent_id: hub.host, result: r } } : { status: 200, body: r };
    }
    // 转发给被控端
    const payload = type === "shell" ? { command: cmd } : body.payload || {};
    const { cmdId, agent, err } = hub.queueCommand(body.agent_id, type, payload);
    if (err) return { status: 404, body: { error: err } };
    if (!sync) return { status: 200, body: { cmd_id: cmdId, agent_id: agent.id, type } };
    const result = await hub.waitResult(agent, cmdId, timeoutMs);
    if (!result) return { status: 504, body: { status: "timeout", agent_id: agent.id, cmd_id: cmdId } };
    return { status: 200, body: { status: "completed", agent_id: agent.id, cmd_id: cmdId, result } };
  }

  if (route === "/api/broadcast" && method === "POST") {
    const cmd = body.cmd || body.command || "";
    const type = body.type || "shell";
    const payload = type === "shell" ? { command: cmd } : body.payload || {};
    const delivered = [];
    for (const [id] of hub.agents) {
      const { cmdId } = hub.queueCommand(id, type, payload);
      if (cmdId) delivered.push({ agent_id: id, cmd_id: cmdId });
    }
    return { status: 200, body: { ok: true, delivered } };
  }

  // 中枢机文件操作（全机，不受工作区限制 — 修复中枢用）
  if (route === "/api/ls" && method === "POST") {
    const p = body.path || hub.root;
    try {
      const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
      return { status: 200, body: { path: p, items } };
    } catch (e) {
      return { status: 404, body: { error: String(e.message || e) } };
    }
  }
  if ((route === "/api/read" || route === "/api/file") && method === "POST") {
    const p = body.path || "";
    try {
      return { status: 200, body: { path: p, content: fs.readFileSync(p, "utf8") } };
    } catch (e) {
      return { status: 404, body: { error: String(e.message || e) } };
    }
  }
  if (route === "/api/write" && method === "POST") {
    const p = body.path || "";
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body.content == null ? "" : String(body.content), "utf8");
      return { status: 200, body: { ok: true, path: p, bytes: Buffer.byteLength(body.content == null ? "" : String(body.content)) } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  return { status: 404, body: { error: "not_found", route } };
}

// ═══════════════════════════════════════════════════════════
// 被控端一行接入脚本（动态注入当前隧道 URL）
// 取之尽锱铢：完整能力可改 irm 全量 client；此处大道至简，shell 即够。
// ═══════════════════════════════════════════════════════════

function buildBootstrap(hubUrl) {
  hubUrl = (hubUrl || "").replace(/\/$/, "");
  return `# dao 被控端 · 一行接入 · 道生一，一命接万机
$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
try{ $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch{}   # 中文 Windows 输出/回传统一 UTF-8
$U='${hubUrl}'
# 以 UTF-8 字节体 POST：PS5.1 默认按 ANSI 编码字符串体 → 非 ASCII 乱码且可能令中枢 JSON.parse 失败丢结果
function Dao-Post($path,$obj){ $b=[Text.Encoding]::UTF8.GetBytes(($obj|ConvertTo-Json -Depth 8 -Compress)); return irm "$U$path" -Method POST -Body $b -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 }
$sys=@{ hostname=$env:COMPUTERNAME; username=$env:USERNAME; os_version=[Environment]::OSVersion.VersionString; ps_version=$PSVersionTable.PSVersion.ToString(); capabilities=@('shell') }
try { $reg = Dao-Post '/api/connect' @{sysinfo=$sys} } catch { Write-Host "[dao] connect failed: $($_.Exception.Message)" -ForegroundColor Red; return }
$aid=$reg.agent_id; $tok=$reg.token
Write-Host "[dao] 已接入中枢 as $aid  (Ctrl+C 退出)" -ForegroundColor Green
while($true){
  try{
    $poll = irm "$U/api/poll?id=$aid&token=$tok&timeout=25" -TimeoutSec 35
    foreach($c in @($poll.commands)){
      if(-not $c){ continue }
      $out=''; $err=''; $code=0
      $sw=[Diagnostics.Stopwatch]::StartNew()
      $global:LASTEXITCODE=0
      try{
        switch($c.type){
          'sysinfo' { $out = (Get-ComputerInfo | Out-String) }
          default {
            # 修复工具要看见错误。本版 PS 下 2>&1 不收编 cmdlet 非终止错误且 $? 不可靠,
            # 故清空 $Error → 跑命令 → 用 $Error 判定失败并把错误文本补进输出。
            $Error.Clear()
            $ErrorActionPreference='Continue'
            $raw = Invoke-Expression $c.payload.command 2>&1
            $ErrorActionPreference='SilentlyContinue'
            $out = ($raw | Out-String)
            if($Error.Count -gt 0){
              $code=1
              $msgs = (@($Error | Select-Object -First 20) | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
              if([string]::IsNullOrWhiteSpace($out)){ $out=$msgs } else { $out = $out + [Environment]::NewLine + $msgs }
            }
            if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){ $code=$LASTEXITCODE }
          }
        }
      }catch{ $err=$_.Exception.Message; $code=1 }
      $sw.Stop()
      $res=@{ stdout=$out; stderr=$err; exit_code=$code; execution_time_ms=$sw.ElapsedMilliseconds }
      try{ Dao-Post '/api/result' @{agent_id=$aid;token=$tok;cmd_id=$c.cmd_id;result=$res} | Out-Null }catch{}
    }
  }catch{
    # token 失效（中枢重启）→ 重注册
    try{ $reg = Dao-Post '/api/connect' @{sysinfo=$sys}; $aid=$reg.agent_id; $tok=$reg.token }catch{ Start-Sleep 3 }
  }
}
`;
}

// ═══════════════════════════════════════════════════════════
// 云端 Agent 接入文档 — 把它发给云端/本地 Agent 即可操控本中枢与一切被控端。
// 含「所有在线设备（含中枢自己）+ 操作逻辑」，随设备接入实时刷新。
// ═══════════════════════════════════════════════════════════

function buildCloudDoc(hub) {
  const url = hub.publicUrl || "http://127.0.0.1:" + hub.port;
  const tunnel = hub.tunnelMethod || "pending";
  const online = hub.agentList().filter((a) => a.status === "online");
  // 设备清单：中枢自己（agent_id 空）置顶，其余被控端依次列出
  const rows = [["（空）/ " + hub.host, "中枢本机", process.platform, "—", "★ 中枢"]];
  for (const a of online) rows.push([a.id, a.hostname, a.os, a.last_seen, a.user]);
  const table =
    "| agent_id | 主机名 | 系统 | last_seen | 备注/用户 |\n|---|---|---|---|---|\n" +
    rows.map((r) => "| `" + r[0] + "` | " + r[1] + " | " + r[2] + " | " + r[3] + " | " + r[4] + " |").join("\n");

  return `# ☯ 道 · 云端 Agent 接入文档

> 道法自然 · 自动生成，随设备接入实时刷新。把它发给云端/本地 Agent，即可操控本中枢与一切已接入的被控端。

## 接入点

\`\`\`
URL:   ${url}
Token: ${hub.token}
Auth:  Authorization: Bearer <Token>
隧道:  ${tunnel}
\`\`\`

## 三明治架构

\`\`\`
操控端 (你/云端 Agent, REST)  ──agent_id 选目标──▶  中枢 (本机 ${hub.host} + 隧道)  ──▶  被控端 (任意机器, 一行 PowerShell)
\`\`\`

## 当前在线设备（共 ${online.length} 台被控端 + 1 中枢）

${table}

> \`agent_id\` 为空（或 \`self\`/\`local\`/中枢主机名）= 操控**中枢本机**；填某台**主机名**= 操控对应被控端。

## 操作逻辑（操控端 API，需 \`Authorization: Bearer <Token>\`）

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| GET  | /api/agents | - | 在线设备列表（先看再下发）|
| POST | /api/exec-sync | {agent_id,cmd,timeout} | 同步执行（agent_id 空=中枢本机）|
| POST | /api/exec | {agent_id,cmd} | 异步下发，返回 cmd_id |
| POST | /api/broadcast | {cmd} | 广播到所有被控端 |
| GET  | /api/bootstrap.ps1 | - | 被控端一行接入脚本（免鉴权）|

## 被控端接入（任意 Windows 机器，一行）

\`\`\`powershell
irm ${url}/api/bootstrap.ps1 | iex
\`\`\`

接入后 \`GET /api/agents\` 即见到它，再 \`POST /api/exec-sync {agent_id:"<主机名>", cmd:"hostname"}\` 即可操控。

## Python SDK（操控端，复制即用）

\`\`\`python
import urllib.request, json
URL=${JSON.stringify(url)}; TOKEN=${JSON.stringify(hub.token)}
def api(m,p,body=None,t=40):
    d=json.dumps(body).encode() if body else None
    req=urllib.request.Request(f"{URL}{p}",data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=m)
    return json.loads(urllib.request.urlopen(req,timeout=t).read())
print(api("GET","/api/agents"))                                   # 所有在线设备
print(api("POST","/api/exec-sync",{"agent_id":"","cmd":"hostname"}))  # 中枢本机
\`\`\`

*道法自然 · 无为而无不为*
`;
}

// ═══════════════════════════════════════════════════════════
// 本机 HTTP server
// ═══════════════════════════════════════════════════════════

async function findAvailablePort(base) {
  for (let p = base; p < base + 50; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(p, "0.0.0.0");
    });
    if (free) return p;
  }
  return base;
}

async function startServer(hub, opts) {
  opts = opts || {};
  const bind = opts.bind || "0.0.0.0";
  const port = await findAvailablePort(opts.port || 3002);
  hub.port = port;
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const u = new URL(req.url || "/", "http://127.0.0.1:" + port);
    const query = Object.fromEntries(u.searchParams.entries());
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const out = await handleRoute(hub, u.pathname, req.method || "GET", req.headers, query, raw);
        if (out.raw != null) {
          res.writeHead(out.status, { "Content-Type": out.contentType || "text/plain; charset=utf-8" });
          res.end(out.raw);
        } else {
          res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out.body, null, 2));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, bind, () => resolve()));
  return { port, close: () => server.close() };
}

// ═══════════════════════════════════════════════════════════
// 出站 relay 桥（可选：Worker+DurableObject，稳定 *.workers.dev）
// 默认走 cloudflared 透明隧道；relay 为信封模式备援。
// ═══════════════════════════════════════════════════════════

function connectRelay(hub, opts) {
  let WebSocket;
  try {
    WebSocket = require("ws");
  } catch {
    return { isConnected: () => false, stop: () => {} };
  }
  let sock = null;
  let connected = false;
  let stopped = false;
  const base = opts.relayUrl.replace(/\/$/, "");
  const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(opts.sessionId) + "&token=" + encodeURIComponent(opts.token);
  function open() {
    if (stopped) return;
    try {
      sock = new WebSocket(wsUrl);
    } catch {
      return schedule();
    }
    sock.on("open", () => {
      connected = true;
      hub.publicUrl = base + "/relay/" + opts.sessionId;
    });
    sock.on("message", async (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.type === "ping" || m.type === "pong") return;
      if (m.type === "request" && m.id) {
        const u = new URL((m.path || "/api/health"), "http://x");
        const query = Object.fromEntries(u.searchParams.entries());
        const fwd = Object.assign({}, m.headers || {}, { authorization: "Bearer " + hub.token });
        const out = await handleRoute(hub, u.pathname, m.method || "GET", fwd, query, typeof m.body === "string" ? m.body : JSON.stringify(m.body || {}));
        try {
          sock.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: out.raw != null ? out.raw : out.body }));
        } catch {}
      }
    });
    sock.on("close", () => {
      connected = false;
      schedule();
    });
    sock.on("error", () => {
      try {
        sock.close();
      } catch {}
    });
  }
  let timer = null;
  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(open, 3000);
  }
  open();
  setInterval(() => {
    if (connected) try {
      sock.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 15000);
  return {
    isConnected: () => connected,
    stop: () => {
      stopped = true;
      try {
        sock.close();
      } catch {}
    },
  };
}

module.exports = { Hub, handleRoute, startServer, connectRelay, buildBootstrap, buildCloudDoc, runShell, findAvailablePort };
