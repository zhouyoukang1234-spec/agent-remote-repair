// ═══════════════════════════════════════════════════════════
// 道 · 自检 — 三明治端到端契约测试（无需外网/隧道）
//   操控端 → 中枢(本机) → 被控端(模拟) 的 队列/轮询/结果 全链路
// ═══════════════════════════════════════════════════════════
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Hub, startServer, buildBootstrap, buildBootstrapSh, platformOf, buildCloudDoc, buildExecCommand } = require("./core");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log("  \u2713 " + name);
  } else {
    fail++;
    console.log("  \u2717 " + name);
  }
}

function api(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const req = http.request(u, { method, headers }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(c).toString();
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const TOKEN = "test-token-" + Date.now();
  const hub = new Hub({ token: TOKEN, version: "test" });
  const srv = await startServer(hub, { port: 3911, bind: "127.0.0.1" });
  const BASE = "http://127.0.0.1:" + srv.port;
  console.log("dao self-test on " + BASE);

  // 公开 + 鉴权
  ok("health is public", (await api(BASE, "GET", "/api/health")).status === 200);
  ok("exec without token → 401", (await api(BASE, "POST", "/api/exec-sync", { cmd: "x" })).status === 401);

  // 中枢本机 exec
  const self = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: process.platform === "win32" ? "echo self-ok" : "echo self-ok" }, TOKEN);
  ok("exec-sync SELF runs on hub", self.status === 200 && self.json.result.stdout.includes("self-ok"));

  // SELF 路径回归（仅 Windows）：UTF-8 输出 + 原生退出码透传
  if (process.platform === "win32") {
    const u8 = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: 'Write-Output "中文-道法自然"', timeout: 20 }, TOKEN);
    ok("SELF preserves UTF-8 (中文 not ?)", u8.status === 200 && u8.json.result.stdout.includes("中文") && !u8.json.result.stdout.includes("?"));
    const ec = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: "cmd /c exit 7", timeout: 20 }, TOKEN);
    ok("SELF propagates native exit code 7", ec.status === 200 && ec.json.result.exit_code === 7);
  } else {
    ok("SELF utf8/exit (skipped: non-win)", true);
    ok("SELF exit-code (skipped: non-win)", true);
  }

  // 软编码回归：默认无任何写死别名；opts/env 驱动且大小写不敏感
  const plainHub = new Hub({ token: "t" });
  ok("no hardcoded aliases by default", Object.keys(plainHub.aliases).length === 0 && plainHub.resolveAlias("desktop") === "desktop");
  const aliasHub = new Hub({ token: "t", aliases: { Laptop: "MY-PC" } });
  ok("aliases resolve case-insensitively", aliasHub.resolveAlias("laptop") === "MY-PC" && aliasHub.resolveAlias("LAPTOP") === "MY-PC");

  // 被控端注册
  const reg = (await api(BASE, "POST", "/api/connect", { sysinfo: { hostname: "TEST-PC", username: "t", os_version: "X", capabilities: ["shell"] } })).json;
  ok("connect returns agent_id + token", !!reg.agent_id && !!reg.token);

  // 被控端长轮询循环（模拟一台真机）
  let running = true;
  (async function loop() {
    while (running) {
      const poll = await api(BASE, "GET", `/api/poll?id=${reg.agent_id}&token=${reg.token}&timeout=5`).catch(() => null);
      if (!poll || !poll.json) break;
      for (const c of poll.json.commands || []) {
        await api(BASE, "POST", "/api/result", { agent_id: reg.agent_id, token: reg.token, cmd_id: c.cmd_id, result: { stdout: "TEST-PC ran: " + (c.payload && c.payload.command), stderr: "", exit_code: 0 } });
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 200));

  ok("poll with wrong token → 401", (await api(BASE, "GET", `/api/poll?id=${reg.agent_id}&token=BAD&timeout=1`)).status === 401);

  const agents = (await api(BASE, "GET", "/api/agents", null, TOKEN)).json;
  ok("agents list shows TEST-PC online", agents.agents.some((a) => a.id === "TEST-PC" && a.status === "online"));

  // 云端文档：含中枢、在线设备清单、操作逻辑（随设备接入刷新）
  const doc = buildCloudDoc(hub);
  ok("cloud doc lists online device TEST-PC", doc.includes("TEST-PC") && doc.includes("在线设备"));
  ok("cloud doc carries hub + auth + bootstrap logic", doc.includes(hub.host) && doc.includes("Authorization: Bearer") && doc.includes("/api/bootstrap.ps1"));

  // ── Linux/macOS 被控端（platform=linux）：模拟一台真机，回显 payload.command 以验证中枢按平台下发 ──
  const lreg = (await api(BASE, "POST", "/api/connect", { sysinfo: { hostname: "LINUX-PC", username: "u", platform: "linux", os_version: "Linux x", capabilities: ["shell", "run", "detached", "sysinfo"] } })).json;
  (async function lloop() {
    while (running) {
      const poll = await api(BASE, "GET", `/api/poll?id=${lreg.agent_id}&token=${lreg.token}&timeout=5`).catch(() => null);
      if (!poll || !poll.json) break;
      for (const c of poll.json.commands || []) {
        await api(BASE, "POST", "/api/result", { agent_id: lreg.agent_id, token: lreg.token, cmd_id: c.cmd_id, result: { stdout: "LINUX-PC ran: " + (c.payload && c.payload.command), stderr: "", exit_code: 0 } });
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 200));

  // 三明治核心：操控端 → 中枢 → 被控端 同步往返
  const routed = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", cmd: "Get-Date", timeout: 10 }, TOKEN);
  ok("exec-sync routes to controlled-end and returns result", routed.status === 200 && routed.json.result.stdout.includes("TEST-PC ran: Get-Date"));

  const unknown = await api(BASE, "POST", "/api/exec-sync", { agent_id: "no-such-agent", cmd: "x", timeout: 2 }, TOKEN);
  ok("exec-sync to unknown agent → 404", unknown.status === 404);

  // 异步 exec → cmd_id → GET /api/result 拉取
  const async1 = await api(BASE, "POST", "/api/exec", { agent_id: "TEST-PC", cmd: "Get-Date" }, TOKEN);
  ok("async exec returns cmd_id", async1.status === 200 && !!async1.json.cmd_id);
  await new Promise((r) => setTimeout(r, 150));
  const fetched = await api(BASE, "GET", `/api/result?agent_id=TEST-PC&cmd_id=${async1.json.cmd_id}`, null, TOKEN);
  ok("GET /api/result fetches async result", fetched.status === 200 && fetched.json.status === "completed" && fetched.json.result.stdout.includes("TEST-PC ran: Get-Date"));
  const pendingFetch = await api(BASE, "GET", `/api/result?agent_id=TEST-PC&cmd_id=cmd_never`, null, TOKEN);
  ok("GET /api/result unknown cmd_id → pending", pendingFetch.status === 200 && pendingFetch.json.status === "pending");

  const bc = await api(BASE, "POST", "/api/broadcast", { cmd: "whoami" }, TOKEN);
  const bids = (bc.json.delivered || []).map((d) => d.agent_id);
  ok("broadcast delivers to all agents (Win + Linux)", bc.json.ok && bc.json.delivered.length === 2 && bids.includes("TEST-PC") && bids.includes("LINUX-PC"));

  const boot = await api(BASE, "GET", "/api/bootstrap.ps1");
  ok("bootstrap.ps1 served, embeds connect+poll loop", boot.status === 200 && boot.raw.includes("/api/connect") && boot.raw.includes("/api/poll"));
  ok("buildBootstrap embeds the hub url", buildBootstrap("https://example.test").includes("https://example.test"));
  ok("bootstrap advertises richer capabilities (cmd/run/detached)", boot.raw.includes("'shell','cmd','run','detached'"));

  // ── buildExecCommand 规范化：.bat/.cmd/.exe/任意操作的根本修复 ──
  ok("shell type passes command through (back-compat)", buildExecCommand({ cmd: "Get-Date" }) === "Get-Date");
  const runExpr = buildExecCommand({ type: "run", file: "C:\\to ol\\my app.bat", args: ["x y", "1"] });
  ok("run type uses & call-operator + quotes path/args (bat fix)", runExpr.startsWith("& 'C:\\to ol\\my app.bat'") && runExpr.includes("'x y'") && runExpr.includes("'1'"));
  ok("bare file (no type) is treated as run", buildExecCommand({ file: "C:\\a\\b.exe" }).startsWith("& 'C:\\a\\b.exe'"));
  const cmdExpr = buildExecCommand({ type: "cmd", cmd: "dir & echo hi" });
  ok("cmd type runs via cmd.exe /c with chcp 65001 (UTF-8)", cmdExpr.includes("cmd.exe /d /c") && cmdExpr.includes("chcp 65001>nul & dir & echo hi"));
  const detExpr = buildExecCommand({ type: "detached", file: "notepad.exe" });
  ok("detached type uses Start-Process -PassThru (non-blocking)", detExpr.includes("Start-Process -FilePath 'notepad.exe'") && detExpr.includes("-PassThru") && detExpr.includes("-WindowStyle Hidden"));
  ok("elevate adds -Verb RunAs", buildExecCommand({ type: "detached", file: "x.exe", elevate: true }).includes("-Verb RunAs"));
  ok("cwd prepends Set-Location", buildExecCommand({ cmd: "pwd", cwd: "C:\\tmp" }).startsWith("Set-Location -LiteralPath 'C:\\tmp';"));

  // ── buildExecCommand POSIX 分支（Linux/macOS 本机；targetPlatform 非 win32）──
  ok("posix shell passes through", buildExecCommand({ cmd: "uname -a" }, "linux") === "uname -a");
  ok("posix cmd type degrades to shell (no cmd.exe)", buildExecCommand({ type: "cmd", cmd: "echo a && echo b" }, "linux") === "echo a && echo b");
  const pRun = buildExecCommand({ type: "run", file: "/opt/my app.sh", args: ["x y", "1"] }, "linux");
  ok("posix run .sh uses sh + single-quote args", pRun.startsWith("sh '/opt/my app.sh'") && pRun.includes("'x y'") && pRun.includes("'1'") && pRun.endsWith(" 2>&1"));
  ok("posix run bare bin execs directly", buildExecCommand({ type: "run", file: "/usr/bin/node" }, "linux").startsWith("'/usr/bin/node'"));
  const pDet = buildExecCommand({ type: "detached", cmd: "sleep 5" }, "linux");
  ok("posix detached uses nohup + pid echo", pDet.startsWith("nohup sleep 5 ") && pDet.includes(">/dev/null 2>&1 &") && pDet.includes("started pid=$!"));
  ok("posix cwd prepends cd &&", buildExecCommand({ cmd: "pwd", cwd: "/tmp/x y" }, "linux").startsWith("cd '/tmp/x y' && "));

  // 路由：操控端 type:run → 中枢 → 被控端(Windows)，payload.command 携带 & 表达式
  const routedRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", type: "run", file: "C:\\tool\\x.bat", args: ["a"], timeout: 10 }, TOKEN);
  ok("exec-sync run routes built &-expression to controlled-end", routedRun.status === 200 && routedRun.json.result.stdout.includes("& 'C:\\tool\\x.bat' 'a'"));

  // ── 跨平台路由：同一请求，中枢按目标被控端平台下发不同指令 ──
  // Windows 被控端 → PowerShell；Linux 被控端 → /bin/sh（这就是"不兼容就两套指令，中枢自动选"）
  const lrun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "LINUX-PC", type: "run", file: "/opt/my app.sh", args: ["a b"], timeout: 10 }, TOKEN);
  ok("exec-sync routes POSIX sh-expression to Linux controlled-end", lrun.status === 200 && lrun.json.result.stdout.includes("LINUX-PC ran: sh '/opt/my app.sh' 'a b' 2>&1"));
  const lsh = await api(BASE, "POST", "/api/exec-sync", { agent_id: "LINUX-PC", cmd: "uname -a", timeout: 10 }, TOKEN);
  ok("exec-sync routes bare shell to Linux controlled-end (no PS)", lsh.json.result.stdout.includes("LINUX-PC ran: uname -a"));

  // platformOf：显式 platform 优先；os_version 推断；缺省回退 win32（向后兼容）
  ok("platformOf explicit linux", platformOf({ sysinfo: { platform: "linux" } }) === "linux");
  ok("platformOf windows os_version", platformOf({ sysinfo: { os_version: "Microsoft Windows NT 10.0" } }) === "win32");
  ok("platformOf linux os_version", platformOf({ sysinfo: { os_version: "Linux box 5.15" } }) === "linux");
  ok("platformOf unknown defaults win32 (back-compat)", platformOf({ sysinfo: { os_version: "X" } }) === "win32");

  // bootstrap.sh：Linux/macOS 一行接入脚本（免鉴权），含 connect/poll/result 循环
  const bootSh = await api(BASE, "GET", "/api/bootstrap.sh");
  ok("bootstrap.sh served, embeds connect+poll+result loop", bootSh.status === 200 && bootSh.raw.includes("/api/connect") && bootSh.raw.includes("/api/poll") && bootSh.raw.includes("/api/result"));
  ok("bootstrap.sh registers platform + uses /bin/sh", bootSh.raw.includes("'platform': sys.platform") && bootSh.raw.includes("/bin/sh"));
  ok("buildBootstrapSh embeds the hub url", buildBootstrapSh("https://example.test").includes("https://example.test"));
  ok("cloud doc advertises bootstrap.sh for Linux/macOS", doc.includes("/api/bootstrap.sh") || buildCloudDoc(hub).includes("/api/bootstrap.sh"));

  // SELF 真机实跑（仅 Windows）：真实 .bat 与 cmd 类型在中枢本机执行
  if (process.platform === "win32") {
    const batPath = path.join(os.tmpdir(), "dao_selftest_" + Date.now() + ".bat");
    fs.writeFileSync(batPath, "@echo off\r\necho dao-bat-ran %1\r\nexit /b 3\r\n");
    const batRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "run", file: batPath, args: ["TOKEN42"], timeout: 25 }, TOKEN);
    ok("SELF runs a real .bat via type:run (stdout + native exit code)", batRun.status === 200 && batRun.json.result.stdout.includes("dao-bat-ran TOKEN42") && batRun.json.result.exit_code === 3);
    try { fs.unlinkSync(batPath); } catch {}
    const cmdRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "cmd", cmd: "echo cmd-type-ok", timeout: 20 }, TOKEN);
    ok("SELF runs cmd type via cmd.exe", cmdRun.status === 200 && cmdRun.json.result.stdout.includes("cmd-type-ok"));
  } else {
    // SELF 真机实跑（Linux/macOS）：.sh 运行 / cmd 降级 shell / detached / sysinfo
    const shPath = path.join(os.tmpdir(), "dao_selftest_" + Date.now() + ".sh");
    fs.writeFileSync(shPath, "#!/bin/sh\necho dao-sh-ran $1\nexit 3\n");
    const shRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "run", file: shPath, args: ["TOKEN42"], timeout: 25 }, TOKEN);
    ok("SELF runs a real .sh via type:run (stdout + native exit code)", shRun.status === 200 && shRun.json.result.stdout.includes("dao-sh-ran TOKEN42") && shRun.json.result.exit_code === 3);
    try { fs.unlinkSync(shPath); } catch {}
    const cmdRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "cmd", cmd: "echo cmd-type-ok && echo two", timeout: 20 }, TOKEN);
    ok("SELF runs cmd type via /bin/sh", cmdRun.status === 200 && cmdRun.json.result.stdout.includes("cmd-type-ok") && cmdRun.json.result.stdout.includes("two"));
    const detRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "detached", cmd: "sleep 1", timeout: 20 }, TOKEN);
    ok("SELF detached via nohup returns pid", detRun.status === 200 && detRun.json.result.stdout.includes("started pid="));
    const siRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "sysinfo", timeout: 25 }, TOKEN);
    ok("SELF sysinfo via uname/os-release", siRun.status === 200 && siRun.json.result.stdout.includes("=== SYSTEM ==="));
  }

  running = false;
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
