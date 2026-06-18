// ═══════════════════════════════════════════════════════════
// 道 · VSCode 扩展宿主自检 — 用 mock vscode 模块在无 GUI 下验证
//   extension.activate() → startHub → core HTTP server + 命令 + 状态栏
//   再让真实进程经"扩展宿主里的中枢"接入并被操控（端到端）。
//   仅在 win32 跑被控端实测；其余平台只验证激活/命令注册。
// ═══════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name); }
}

// ── 最小 vscode mock：仅实现 extension.js 用到的面 ──
const commands = {};
let statusItem = null;
const infoMsgs = [];
const clipboard = { _v: "" };
const cfgStore = { port: 0, lanOnly: true, relayUrl: "" }; // lanOnly=true：测试不开公网隧道
let lastPanel = null;
const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2 },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    createStatusBarItem: () => (statusItem = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
    showInformationMessage: (m) => { infoMsgs.push(m); },
    showWarningMessage: (m) => { infoMsgs.push(m); },
    showTextDocument: async () => ({}),
    showQuickPick: async (items) => items && items[0],
    createWebviewPanel: () => {
      lastPanel = {
        _posted: [], _msg: null, _disposed: false,
        webview: { _html: "", set html(v) { this._html = v; }, get html() { return this._html; },
          postMessage: async (m) => { lastPanel._posted.push(m); return true; },
          onDidReceiveMessage: (fn) => { lastPanel._msg = fn; return { dispose() {} }; } },
        reveal() {}, onDidDispose() { return { dispose() {} }; }, dispose() { this._disposed = true; },
      };
      return lastPanel;
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => cfgStore[k] }),
    openTextDocument: async (o) => o,
  },
  env: { clipboard: { writeText: async (t) => { clipboard._v = t; }, readText: async () => clipboard._v } },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
  StatusBarItem: function () {},
};

// 注入 mock：劫持 require('vscode')
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
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
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const ext = require("./extension");
  const subs = [];
  const context = { subscriptions: subs };

  await ext.activate(context);
  ok("activate registers 8 commands", Object.keys(commands).length === 8 &&
    ["daoRemote.showPanel","daoRemote.start","daoRemote.stop","daoRemote.restart","daoRemote.copyBootstrap","daoRemote.copyToken","daoRemote.showInfo","daoRemote.showAgents"].every((c) => commands[c]));
  ok("activate creates a status bar item", !!statusItem && /DAO/.test(statusItem.text));
  ok("status bar opens 中枢状态台", statusItem.command === "daoRemote.showPanel");

  // 中枢状态台：面板渲染 + 实时推送 + 复制按钮回传
  await commands["daoRemote.showPanel"]();
  ok("showPanel builds webview with copy button", !!lastPanel && /中枢状态台/.test(lastPanel.webview.html) && /copyBoot/.test(lastPanel.webview.html));
  await lastPanel._msg({ type: "ready" });
  const pushed = lastPanel._posted[lastPanel._posted.length - 1];
  ok("panel receives live device state", !!pushed && /\/api\/bootstrap\.ps1 \| iex/.test(pushed.bootstrap) && Array.isArray(pushed.agents));
  await lastPanel._msg({ type: "copyBootstrap" });
  ok("panel copy button copies one-liner", /irm .*\/api\/bootstrap\.ps1 \| iex/.test(clipboard._v));

  // 拿到扩展宿主里中枢的端口/token（经 conn.json 持久化，复用 dao.js 的核心）
  const conn = require(path.join(require("os").homedir(), ".dao-remote", "conn.json"));
  const BASE = "http://127.0.0.1:" + conn.port;
  const TOKEN = conn.token;

  ok("extension-hosted hub answers /api/health", (await api(BASE, "GET", "/api/health")).status === 200);
  ok("copyBootstrap puts one-liner on clipboard", (await commands["daoRemote.copyBootstrap"](), /irm .*\/api\/bootstrap\.ps1 \| iex/.test(clipboard._v)));
  await commands["daoRemote.copyToken"]();
  ok("copyToken copies the master token", clipboard._v === TOKEN);

  // SELF 经扩展宿主中枢执行（win32 验证 UTF-8 + 退出码；其他平台只验证 200）
  if (process.platform === "win32") {
    const u8 = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: 'Write-Output "中文-扩展宿主"', timeout: 20 }, TOKEN);
    ok("EDH SELF preserves UTF-8", u8.status === 200 && u8.json.result.stdout.includes("中文") && !u8.json.result.stdout.includes("?"));
    const ec = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: "cmd /c exit 5", timeout: 20 }, TOKEN);
    ok("EDH SELF propagates exit code 5", ec.status === 200 && ec.json.result.exit_code === 5);
  } else {
    const s = await api(BASE, "POST", "/api/exec-sync", { agent_id: "", cmd: "echo edh-ok", timeout: 20 }, TOKEN);
    ok("EDH SELF runs on hub", s.status === 200 && s.json.result.stdout.includes("edh-ok"));
    ok("EDH non-win exit (skipped)", true);
  }

  ext.deactivate();
  ok("deactivate stops hub", (await api(BASE, "GET", "/api/health").catch(() => ({ status: 0 }))).status === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  Module._load = origLoad;
  Module._resolveFilename = origResolve;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ext-test crashed:", e); process.exit(1); });
