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
  relayUrl: "", disableRelay: true, autoProxy: false, confineToWorkspace: false,
  cloudflaredPath: "", cfApiToken: "", tunnelToken: "", hostname: "", localPort: 0,
  accessToken: "", proxyUrl: "", session: "",
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
  const { Bridge, WorkspaceServer, BridgeViewProvider, buildBootstrap } = ext;

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

  console.log(`\n${pass} passed, ${fail} failed`);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ext-test crashed:", e); process.exit(1); });
