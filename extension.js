"use strict";
// ═══════════════════════════════════════════════════════════
// 道 · VSCode 扩展宿主 — 中枢端运行插件
//
// 反者道之动：本源 dao-bridge 是 VSCode 插件。本文件让 agent-remote-repair
// 既能 `node dao.js` 当独立进程跑，也能作为 VSCode 扩展在编辑器内激活：
// 激活即在扩展宿主里启动 core.js 的 Hub + HTTP server + 出站隧道，
// 编辑器本身成为三明治的「中枢」。一份 core，两种宿主，大道至简。
// ═══════════════════════════════════════════════════════════

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { Hub, startServer, connectRelay, buildBootstrap } = require("./core");
const tunnel = require("./remote-agent/dao_tunnel");

const pkg = (() => {
  try {
    return require("./package.json");
  } catch {
    return { version: "0.0.0" };
  }
})();

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

let hub = null;
let serverHandle = null;
let statusItem = null;
let output = null;
let statusTimer = null;
let started = false;

function log(msg) {
  if (output) output.appendLine("[" + new Date().toISOString() + "] " + msg);
}

function cfg() {
  return vscode.workspace.getConfiguration("daoRemote");
}

function localUrl() {
  return "http://127.0.0.1:" + (hub && hub.port ? hub.port : "?");
}

function publicOrLocal() {
  return (hub && hub.publicUrl) || localUrl();
}

function refreshStatus() {
  if (!statusItem) return;
  if (!hub || !hub.port) {
    statusItem.text = "$(radio-tower) DAO: 未启动";
    statusItem.tooltip = "点击启动 DAO 远程中枢";
    statusItem.show();
    return;
  }
  const online = hub.agentList().filter((a) => a.status === "online").length;
  const url = hub.publicUrl ? hub.publicUrl.replace(/^https?:\/\//, "") : "本地:" + hub.port;
  statusItem.text = "$(radio-tower) DAO " + url + " · " + online + " 被控端";
  statusItem.tooltip =
    "DAO 远程中枢（中枢=本编辑器）\n公网: " +
    publicOrLocal() +
    "\nToken: " +
    (hub.token || "") +
    "\n在线被控端: " +
    online +
    "\n点击查看接入信息";
  statusItem.show();
}

async function startHub() {
  if (started) return;
  started = true;
  const conn = loadConn();
  const c = cfg();
  const token = process.env.DAO_TOKEN || conn.token || crypto.randomBytes(24).toString("hex");
  const session = conn.session || crypto.randomBytes(16).toString("hex");
  const port = Number(c.get("port")) || Number(process.env.PORT) || 3002;
  const noTunnel = !!c.get("lanOnly") || process.env.NO_TUNNEL === "1";
  const relayUrl = String(c.get("relayUrl") || process.env.DAO_RELAY_URL || "");

  hub = new Hub({ token, version: pkg.version, root: os.homedir() });
  serverHandle = await startServer(hub, { port, bind: "0.0.0.0" });
  saveConn({ token: hub.token, session, port: hub.port, updated: new Date().toISOString() });
  log("HTTP server 已监听 " + localUrl());

  if (noTunnel) {
    hub.tunnelMethod = "lan-only";
    log("LAN-only 模式：不开隧道");
  } else if (relayUrl) {
    hub.tunnelMethod = "relay";
    connectRelay(hub, { relayUrl, sessionId: session, token: hub.token });
    log("relay 模式：" + relayUrl);
  } else {
    tunnel.onUrl((u) => {
      hub.publicUrl = u;
      hub.tunnelMethod = tunnel.method || "cloudflared";
      log("公网隧道就绪：" + u + " [" + hub.tunnelMethod + "]");
      refreshStatus();
      vscode.window.showInformationMessage("DAO 中枢已上公网：" + u);
    });
    tunnel.start(hub.port);
    log("cloudflared 隧道启动中…");
  }

  if (!statusTimer) statusTimer = setInterval(refreshStatus, 3000);
  refreshStatus();
}

function stopHub() {
  try {
    tunnel.stop();
  } catch {}
  try {
    if (serverHandle && serverHandle.close) serverHandle.close();
  } catch {}
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  hub = null;
  serverHandle = null;
  started = false;
  log("中枢已停止");
  refreshStatus();
}

function infoMarkdown() {
  const url = publicOrLocal();
  return (
    "# ☯ DAO 远程中枢 · 接入信息\n\n" +
    "- 中枢宿主: 本编辑器 (" + (hub ? hub.host : os.hostname()) + ")\n" +
    "- 公网/本地 URL: `" + url + "`\n" +
    "- Token: `" + (hub ? hub.token : "") + "`\n" +
    "- 在线被控端: " + (hub ? hub.agentList().filter((a) => a.status === "online").length : 0) + "\n\n" +
    "## 被控端一行接入（任意 Windows 机器）\n\n" +
    "```powershell\nirm " + url + "/api/bootstrap.ps1 | iex\n```\n\n" +
    "## 操控端（需 Bearer Token）\n\n" +
    "```\nPOST " + url + "/api/exec-sync   {agent_id, cmd, timeout}\nGET  " + url + "/api/agents\n```\n"
  );
}

function register(context, id, fn) {
  context.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

async function activate(context) {
  output = vscode.window.createOutputChannel("DAO Remote");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "daoRemote.showInfo";
  context.subscriptions.push(output, statusItem);
  log("DAO Remote 扩展激活 v" + pkg.version);

  register(context, "daoRemote.start", () => startHub());
  register(context, "daoRemote.stop", () => stopHub());
  register(context, "daoRemote.restart", async () => {
    stopHub();
    await startHub();
  });
  register(context, "daoRemote.copyBootstrap", async () => {
    const line = "irm " + publicOrLocal() + "/api/bootstrap.ps1 | iex";
    await vscode.env.clipboard.writeText(line);
    vscode.window.showInformationMessage("已复制被控端一行接入指令：" + line);
  });
  register(context, "daoRemote.copyToken", async () => {
    if (!hub) return vscode.window.showWarningMessage("中枢未启动");
    await vscode.env.clipboard.writeText(hub.token);
    vscode.window.showInformationMessage("已复制中枢 Token");
  });
  register(context, "daoRemote.showInfo", async () => {
    const doc = await vscode.workspace.openTextDocument({ content: infoMarkdown(), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  register(context, "daoRemote.showAgents", async () => {
    if (!hub) return vscode.window.showWarningMessage("中枢未启动");
    const items = hub.agentList().map((a) => ({
      label: (a.status === "online" ? "$(pass-filled) " : "$(circle-slash) ") + a.id,
      description: a.user + " · " + a.os,
      detail: "status=" + a.status + " · last_seen=" + a.last_seen + " · pending=" + a.pending,
    }));
    if (!items.length) return vscode.window.showInformationMessage("当前无被控端接入");
    await vscode.window.showQuickPick(items, { placeHolder: "已接入的被控端（共 " + items.length + "）" });
  });

  await startHub();
}

function deactivate() {
  stopHub();
}

module.exports = { activate, deactivate };
