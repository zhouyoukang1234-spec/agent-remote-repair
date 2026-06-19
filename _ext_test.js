// ═══════════════════════════════════════════════════════════
// 道 · 插件自检（本源 dao-bridge-ext + 三明治演化）— mock vscode，无 GUI。
//   验证：WorkspaceServer 路由(connect/poll/result/exec 路由/broadcast/bootstrap)
//   + 前端 html() 含本源4模块 + 演化「在线设备」模块
//   + state()/generateCloudAgentMd() 含设备清单与一行接入指令
//   + activate 注册本源命令 + 侧栏视图 daoBridgeView。
//   仅在 win32 跑 SELF 的 UTF-8/退出码实测；被控端路由用进程内模拟轮询验证。
// ═══════════════════════════════════════════════════════════
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name); }
}

// ── 最小 vscode mock ──
const commands = {};
const infoMsgs = [];
const clipboard = { _v: "" };
const cfgStore = {
  autoProxy: false, confineToWorkspace: false,
  cloudflaredPath: "", cfApiToken: "", tunnelToken: "", hostname: "", localPort: 0,
  accessToken: "", proxyUrl: "",
};
let lastViewProvider = null;
const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2 },
  Uri: { parse: (s) => ({ toString: () => s }) },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
    setStatusBarMessage: () => ({ dispose() {} }),
    showInformationMessage: (m) => { infoMsgs.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { infoMsgs.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { infoMsgs.push(m); return Promise.resolve(undefined); },
    showTextDocument: async () => ({}),
    registerWebviewViewProvider: (id, provider) => { lastViewProvider = { id, provider }; return { dispose() {} }; },
  },
  workspace: {
    workspaceFolders: [],
    name: "",
    getConfiguration: () => ({ get: (k) => cfgStore[k], update: async () => {} }),
    openTextDocument: async (o) => o,
  },
  env: {
    appName: "Test VS Code", machineId: "m", sessionId: "s",
    clipboard: { writeText: async (t) => { clipboard._v = t; }, readText: async () => clipboard._v },
    openExternal: async () => true,
  },
  version: "1.124.0",
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  extensions: { all: [], getExtension: () => undefined },
};

// 注入 mock：劫持 require('vscode')
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscodeMock;
  return origLoad.apply(this, arguments);
};

function api(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const req = http.request(u, { method, headers }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => { const raw = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const ext = require("./extension");
  const { Bridge, WorkspaceServer, BridgeViewProvider, buildBootstrap, buildBootstrapSh, platformOf } = ext;

  // ── 直接起 WorkspaceServer（不开隧道）──
  const bridge = new Bridge({ subscriptions: [] });
  const srv = bridge.srv;
  await srv.start(0);
  const BASE = "http://127.0.0.1:" + srv.port;
  const TOKEN = srv.token;

  ok("hub answers /api/health (no auth)", (await api(BASE, "GET", "/api/health")).status === 200);
  ok("protected route rejects without token", (await api(BASE, "GET", "/api/agents")).status === 401);

  // bootstrap 脚本（免鉴权，纯文本）
  const boot = await api(BASE, "GET", "/api/bootstrap.ps1");
  ok("serves bootstrap.ps1 (no auth)", boot.status === 200 && /\/api\/connect/.test(boot.raw) && /\/api\/poll/.test(boot.raw));

  // 被控端接入
  const sysinfo = { hostname: "TEST-PC", username: "u", os_version: "win-test", capabilities: ["shell"] };
  const conn = await api(BASE, "POST", "/api/connect", { sysinfo });
  ok("被控端 connect 返回 agent_id + token", conn.status === 200 && conn.json.agent_id === "TEST-PC" && !!conn.json.token);
  const aid = conn.json.agent_id, atok = conn.json.token;

  const agents = await api(BASE, "GET", "/api/agents", null, TOKEN);
  ok("/api/agents 列出在线被控端", agents.status === 200 && agents.json.agents.some((a) => a.id === "TEST-PC" && a.status === "online"));

  // 进程内模拟被控端：长轮询取命令 → 回传结果
  let polling = true;
  (async function poller() {
    while (polling) {
      const pr = await api(BASE, "POST", "/api/poll", { id: aid, token: atok, timeout: 2 }).catch(() => ({ json: { commands: [] } }));
      for (const c of (pr.json && pr.json.commands) || []) {
        await api(BASE, "POST", "/api/result", { agent_id: aid, token: atok, cmd_id: c.cmd_id, result: { stdout: "echo:" + (c.payload && c.payload.command), stderr: "", exit_code: 0 } });
      }
    }
  })();

  // 操控端 → 中枢 → 被控端（exec-sync 路由）
  const routed = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", cmd: "hostname", timeout: 10 }, TOKEN);
  ok("exec-sync 路由到被控端并回结果", routed.status === 200 && routed.json.status === "completed" && routed.json.agent_id === "TEST-PC" && /echo:hostname/.test(routed.json.result.stdout));

  // 广播到所有被控端
  const bc = await api(BASE, "POST", "/api/broadcast", { cmd: "whoami" }, TOKEN);
  ok("broadcast 入队所有被控端", bc.status === 200 && Array.isArray(bc.json.delivered) && bc.json.delivered.some((d) => d.agent_id === "TEST-PC"));

  // type:run → 被控端：payload.command 携带 & 调用运算符表达式（.bat/.exe 根本修复）
  const routedRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", type: "run", file: "C:\\tool\\x.bat", args: ["a"], timeout: 10 }, TOKEN);
  ok("exec-sync run 转发 &-表达式到被控端", routedRun.status === 200 && routedRun.json.result.stdout.includes("& 'C:\\tool\\x.bat' 'a'"));
  const routedCmd = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", type: "cmd", cmd: "echo hi", timeout: 10 }, TOKEN);
  ok("exec-sync cmd 转发 cmd.exe/chcp 到被控端", routedCmd.status === 200 && routedCmd.json.result.stdout.includes("cmd.exe /d /c") && routedCmd.json.result.stdout.includes("chcp 65001"));

  // ── Linux/macOS 被控端（platform=linux）：中枢按目标平台下发 POSIX 指令（不是 PowerShell）──
  const lconn = await api(BASE, "POST", "/api/connect", { sysinfo: { hostname: "LINUX-PC", username: "u", platform: "linux", os_version: "Linux x", capabilities: ["shell", "run", "detached", "sysinfo"] } });
  const laid = lconn.json.agent_id, latok = lconn.json.token;
  let lpolling = true;
  (async function lpoller() {
    while (lpolling) {
      const pr = await api(BASE, "POST", "/api/poll", { id: laid, token: latok, timeout: 2 }).catch(() => ({ json: { commands: [] } }));
      for (const c of (pr.json && pr.json.commands) || []) {
        await api(BASE, "POST", "/api/result", { agent_id: laid, token: latok, cmd_id: c.cmd_id, result: { stdout: "L:" + (c.payload && c.payload.command), stderr: "", exit_code: 0 } });
      }
    }
  })();
  const lrun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "LINUX-PC", type: "run", file: "/opt/my app.sh", args: ["a b"], timeout: 10 }, TOKEN);
  ok("exec-sync 路由 POSIX sh-表达式到 Linux 被控端", lrun.status === 200 && lrun.json.result.stdout.includes("L:sh '/opt/my app.sh' 'a b' 2>&1"));
  const ldet = await api(BASE, "POST", "/api/exec-sync", { agent_id: "LINUX-PC", type: "detached", cmd: "sleep 1", timeout: 10 }, TOKEN);
  ok("exec-sync 路由 POSIX nohup 到 Linux 被控端", ldet.json.result.stdout.includes("L:nohup sleep 1 >/dev/null 2>&1"));
  lpolling = false;

  // platformOf 与 bootstrap.sh
  ok("platformOf 显式 linux", platformOf({ sysinfo: { platform: "linux" } }) === "linux");
  ok("platformOf 缺省回退 win32", platformOf({ sysinfo: { os_version: "win-test" } }) === "win32");
  const bootSh = await api(BASE, "GET", "/api/bootstrap.sh");
  ok("serves bootstrap.sh (no auth, connect+poll+result)", bootSh.status === 200 && /\/api\/connect/.test(bootSh.raw) && /\/api\/poll/.test(bootSh.raw) && /\/api\/result/.test(bootSh.raw));
  ok("bootstrap.sh 登记 platform 并用 /bin/sh + POST poll", bootSh.raw.includes("'platform': sys.platform") && bootSh.raw.includes("/bin/sh") && bootSh.raw.includes("post('/api/poll'"));
  ok("buildBootstrapSh 嵌入 hub url", buildBootstrapSh("https://ex.test").includes("https://ex.test"));

  // 找不到的被控端
  const nf = await api(BASE, "POST", "/api/exec-sync", { agent_id: "NO-SUCH", cmd: "x", timeout: 3 }, TOKEN);
  ok("路由到不存在的被控端返回 404", nf.status === 404);

  polling = false;

  // SELF（agent_id 空）→ 中枢本机执行（win32 验证 UTF-8 + 退出码）
  if (process.platform === "win32") {
    const u8 = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: 'Write-Output "中文-本机"', timeout: 20 }, TOKEN);
    ok("SELF 保留 UTF-8（中文不乱码）", u8.status === 200 && u8.json.result.stdout.includes("中文") && !u8.json.result.stdout.includes("?"));
    const ec = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: "cmd /c exit 5", timeout: 20 }, TOKEN);
    ok("SELF 透传退出码 5", ec.status === 200 && ec.json.result.exit_code === 5);
    // SELF 真机实跑 .bat（type:run）与 cmd 类型
    const batPath = path.join(os.tmpdir(), "dao_ext_selftest_" + Date.now() + ".bat");
    fs.writeFileSync(batPath, "@echo off\r\necho dao-ext-bat %1\r\nexit /b 4\r\n");
    const batRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "run", file: batPath, args: ["E2E"], timeout: 25 }, TOKEN);
    ok("SELF 实跑 .bat（type:run，stdout + 原生退出码4）", batRun.status === 200 && batRun.json.result.stdout.includes("dao-ext-bat E2E") && batRun.json.result.exit_code === 4);
    try { fs.unlinkSync(batPath); } catch {}
    const cmdRun = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", type: "cmd", cmd: "echo cmd-ext-ok", timeout: 20 }, TOKEN);
    ok("SELF cmd 类型经 cmd.exe 执行", cmdRun.status === 200 && cmdRun.json.result.stdout.includes("cmd-ext-ok"));
  } else {
    const s = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: "echo self-ok", timeout: 20 }, TOKEN);
    ok("SELF 在中枢本机执行", s.status === 200 && s.json.result.stdout.includes("self-ok"));
    ok("SELF 退出码（非 win 跳过）", true);
  }

  // ── 前端 html()：本源4模块 + 演化设备模块 ──
  bridge.url = "https://example.trycloudflare.com";
  const provider = new BridgeViewProvider({ subscriptions: [] }, bridge);
  const html = provider.html();
  ok("html 含本源·实时状态模块", /公网穿透状态/.test(html));
  ok("html 含本源·命名隧道模块", /命名隧道/.test(html));
  ok("html 含本源·导出接入文档模块", /导出接入文档/.test(html));
  ok("html 含本源·能力自测模块", /能力自测/.test(html));
  ok("html 含演化·在线设备模块 + 复制按钮", /在线设备 · 汇入中枢/.test(html) && /copyBootstrap/.test(html));
  ok("html 顶部三按钮(复制 copyAll + 重启 + 刷新Token·无独立 copyUrl/copyToken)", /data-op="copyAll"/.test(html) && /data-op="restart"/.test(html) && /data-op="refreshToken"/.test(html) && !/data-op="copyUrl"/.test(html) && !/data-op="copyToken"/.test(html));
  await provider.handle({ op: "copyAll" });
  ok("copyAll 一键复制 URL+Token(含 Authorization 头)", clipboard._v.includes(bridge.url) && clipboard._v.includes(bridge.srv.token) && /Authorization: Bearer/.test(clipboard._v));

  // ── state() / cloud MD：设备清单 + 一行接入指令 ──
  const st = bridge.state();
  ok("state 含 agents 数组 + bootstrap 一行指令", Array.isArray(st.agents) && /\/api\/bootstrap\.ps1 \| iex/.test(st.bootstrap) && st.host);
  const md = bridge.generateCloudAgentMd();
  ok("cloud MD 含设备清单表头 + 在线被控端", /agent_id \| 主机名/.test(md) && /TEST-PC/.test(md));
  ok("cloud MD 含被控端一行接入指令", /\/api\/bootstrap\.ps1 \| iex/.test(md));

  ok("buildBootstrap 注入 hub URL", /example\.trycloudflare\.com/.test(buildBootstrap("https://example.trycloudflare.com")));

  srv.stop();

  // ── activate：注册本源命令 + 侧栏视图（start 打桩，避免开隧道）──
  Bridge.prototype.start = async function () { return ""; };
  const subs = [];
  ext.activate({ subscriptions: subs });
  const want = ["daoBridgeHub.restart", "daoBridgeHub.copyBootstrap", "daoBridgeHub.logout", "daoBridgeHub.openMd", "daoBridgeHub.exportCloudMd", "daoBridgeHub.exportLocalMd"];
  ok("activate 注册本源6命令(daoBridgeHub 唯一命名空间)", want.every((c) => typeof commands[c] === "function"));
  ok("命令不再用遗留 daoBridge.* 命名空间", typeof commands["daoBridge.restart"] === "undefined");
  ok("activate 注册侧栏 daoBridgeHubView(唯一视图 id)", !!lastViewProvider && lastViewProvider.id === "daoBridgeHubView");
  await commands["daoBridgeHub.copyBootstrap"]();
  ok("copyBootstrap 复制一行接入指令", /irm .*\/api\/bootstrap\.ps1 \| iex/.test(clipboard._v));
  ext.deactivate();

  // ── 冲突规避：webview 强化(CSP/nonce/无内联 onclick) + 遗留插件探测不崩 ──
  ok("html 含 CSP + script nonce", /Content-Security-Policy/.test(html) && /script-src 'nonce-/.test(html));
  ok("html 无内联 onclick(CSP 安全)", !/onclick=/.test(html));
  ok("html 按钮改用 data-op 委托", /data-op="copyBootstrap"/.test(html) && /data-op="exec"/.test(html));
  // 模拟同时装有遗留 dao.dao-bridge(同名命令/视图) —— activate 不得崩, 且给出冲突告警
  infoMsgs.length = 0;
  vscodeMock.extensions.all = [
    { id: "dao.dao-bridge", packageJSON: { displayName: "DAO Bridge·旧", contributes: { commands: [{ command: "daoBridge.restart" }], views: { daoBridge: [{ id: "daoBridgeView" }] } } } },
  ];
  const subs2 = [];
  let crashed = false;
  try { ext.activate({ subscriptions: subs2, extension: { id: "dao.agent-remote-repair" } }); } catch (e) { crashed = true; }
  ok("存在遗留同名插件时 activate 不崩", !crashed && typeof commands["daoBridgeHub.restart"] === "function");
  ok("探测到遗留插件并告警卸载", infoMsgs.some((m) => /遗留插件/.test(String(m))));
  ext.deactivate();
  vscodeMock.extensions.all = [];

  // ── 自愈看门狗：回环自检 + 失败阈值触发自愈 ──
  {
    const wd = new Bridge({ subscriptions: [] });
    // 打桩 start：记录调用、模拟重连后 URL 稳定
    let starts = 0;
    wd.start = async function () { starts++; this.url = "https://stable.example.trycloudflare.com"; return this.url; };
    wd._wdThreshold = 2;
    // 自检失败：累计失败，达到阈值触发自愈(start 被调用、失败计数清零)
    wd._publicHealthCheck = async () => false;
    wd.url = "https://x";
    await wd._wdTick();
    ok("看门狗：自检失败累计 healthFails=1 未达阈值不自愈", wd._healthFails === 1 && starts === 0);
    await wd._wdTick();
    ok("看门狗：连续失败达阈值→自动自愈(start 调用、计数清零)", starts === 1 && wd._healthFails === 0);
    // 自检成功：失败计数清零、记录 lastOkAt
    wd._publicHealthCheck = async () => true;
    wd._healthFails = 5;
    await wd._wdTick();
    ok("看门狗：自检成功→healthFails 清零并记录 lastOkAt", wd._healthFails === 0 && wd._lastOkAt > 0);
    // startWatchdog/stopWatchdog 幂等且可停
    wd.startWatchdog(); const h1 = wd._wd; wd.startWatchdog();
    ok("看门狗：startWatchdog 幂等(不重复 arm)", wd._wd === h1 && !!wd._wd);
    wd.stopWatchdog();
    ok("看门狗：stopWatchdog 停表", wd._wd === null);
  }

  // ── 回环自检 _publicHealthCheck：GET /api/health + 错误识别 ──
  {
    const wd = new Bridge({ subscriptions: [] });
    wd.srv.token = "wdtoken0123456789abcdef0123456789";
    // GET /api/health 200 ok
    const okSrv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", service: "dao" })); });
    await new Promise((r) => okSrv.listen(0, r));
    wd.mode = "quick"; wd.url = "http://127.0.0.1:" + okSrv.address().port;
    ok("回环自检：/api/health 200→true", (await wd._publicHealthCheck()) === true);
    okSrv.close();
    // {error} 响应→false
    const errSrv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no_agent" })); });
    await new Promise((r) => errSrv.listen(0, r));
    wd.mode = "quick"; wd.url = "http://127.0.0.1:" + errSrv.address().port;
    ok("回环自检：{error}响应→false", (await wd._publicHealthCheck()) === false);
    errSrv.close();
    // 无 URL → false
    wd.url = "";
    ok("回环自检：无公网 URL→false", (await wd._publicHealthCheck()) === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ext-test crashed:", e); process.exit(1); });
