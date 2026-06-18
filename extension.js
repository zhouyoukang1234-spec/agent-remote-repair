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

const { Hub, startServer, connectRelay, buildBootstrap, buildCloudDoc } = require("./core");
const tunnel = require("./tunnel");

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
let panel = null;
let lastDocKey = "";

const CLOUD_DOC = path.join(os.homedir(), "DAO_CLOUD_AGENT.md");

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
  const aliases = c.get("aliases") || undefined;

  hub = new Hub({ token, version: pkg.version, root: os.homedir(), aliases });
  serverHandle = await startServer(hub, { port, bind: "0.0.0.0" });
  saveConn({ token: hub.token, session, port: hub.port, updated: new Date().toISOString() });
  lastDocKey = onlineKey();
  writeCloudDoc();
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
      lastDocKey = onlineKey();
      writeCloudDoc();
      tick();
      vscode.window.showInformationMessage("DAO 中枢已上公网：" + u);
    });
    tunnel.start(hub.port);
    log("cloudflared 隧道启动中…");
  }

  if (!statusTimer) statusTimer = setInterval(tick, 3000);
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
  lastDocKey = "";
  log("中枢已停止");
  refreshStatus();
  if (panel) {
    try {
      panel.webview.postMessage(deviceState());
    } catch {}
  }
}

// 当前中枢 + 在线设备快照，推给 Webview 实时渲染
function deviceState() {
  const running = !!(hub && hub.port);
  return {
    running,
    host: hub ? hub.host : os.hostname(),
    localUrl: localUrl(),
    publicUrl: (hub && hub.publicUrl) || "",
    tunnel: (hub && hub.tunnelMethod) || (running ? "pending" : ""),
    token: hub ? hub.token : "",
    port: hub && hub.port ? hub.port : "",
    bootstrap: "irm " + publicOrLocal() + "/api/bootstrap.ps1 | iex",
    agents: running ? hub.agentList() : [],
  };
}

// 云端文档随设备接入/隧道就绪实时刷新（去重：仅在变化时落盘）
function onlineKey() {
  if (!hub || !hub.port) return "down";
  const ids = hub.agentList().filter((a) => a.status === "online").map((a) => a.id).sort().join(",");
  return ids + "|" + (hub.publicUrl || "") + "|" + (hub.tunnelMethod || "");
}
function writeCloudDoc() {
  if (!hub || !hub.port) return;
  try {
    fs.writeFileSync(CLOUD_DOC, buildCloudDoc(hub), "utf8");
  } catch (e) {
    log("写云端文档失败: " + (e && e.message));
  }
}

// 状态栏 + 云端文档 + 面板，统一 3s 心跳刷新
function tick() {
  refreshStatus();
  const key = onlineKey();
  if (key !== lastDocKey) {
    lastDocKey = key;
    writeCloudDoc();
  }
  if (panel) {
    try {
      panel.webview.postMessage(deviceState());
    } catch {}
  }
}

function panelHtml(nonce) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:14px 18px;font-size:13px}
  h2{margin:0 0 4px}.sub{opacity:.7;margin:0 0 14px}
  .grid{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin-bottom:14px}
  .grid .k{opacity:.7}.grid .v{font-family:var(--vscode-editor-font-family);word-break:break-all}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .on{background:#3fb950}.off{background:#f85149}
  .cmd{display:flex;gap:8px;align-items:stretch;margin:10px 0}
  .cmd code{flex:1;background:var(--vscode-textCodeBlock-background);padding:8px 10px;border-radius:4px;font-family:var(--vscode-editor-font-family);white-space:pre-wrap;word-break:break-all}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px}
  button:hover{background:var(--vscode-button-hoverBackground)}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .actions button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  th{opacity:.7;font-weight:600}
  tr.hub td{color:var(--vscode-charts-yellow)}
  .pending{opacity:.7}
  .empty{opacity:.6;padding:10px 0}
</style></head><body>
  <h2>☰ DAO 中枢状态台</h2>
  <p class="sub">中枢=本编辑器 · 去中心化 · 实时刷新</p>
  <div class="grid" id="status"></div>
  <div class="cmd"><code id="boot">…</code><button id="copyBoot" title="复制被控端一行接入指令">复制接入指令</button></div>
  <div class="actions">
    <button id="copyToken">复制 Token</button>
    <button id="copyDoc">复制云端文档</button>
    <button id="openDoc">打开云端文档</button>
  </div>
  <h3 id="devhdr">在线设备</h3>
  <div id="devices"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
    function render(d){
      const dot = d.running ? '<span class="dot on"></span>运行中' : '<span class="dot off"></span>未启动';
      document.getElementById('status').innerHTML =
        '<div class="k">状态</div><div class="v">'+dot+'</div>'+
        '<div class="k">中枢主机</div><div class="v">'+esc(d.host)+'</div>'+
        '<div class="k">本地 URL</div><div class="v">'+esc(d.localUrl)+'</div>'+
        '<div class="k">公网 URL</div><div class="v">'+(d.publicUrl?esc(d.publicUrl):'<i>('+esc(d.tunnel||'未开隧道')+')</i>')+'</div>'+
        '<div class="k">隧道</div><div class="v">'+esc(d.tunnel||'-')+'</div>'+
        '<div class="k">Token</div><div class="v">'+esc(d.token||'-')+'</div>';
      document.getElementById('boot').textContent = d.bootstrap || '…';
      const on = (d.agents||[]).filter(a=>a.status==='online');
      document.getElementById('devhdr').textContent = '在线设备（'+on.length+' 被控端 + 1 中枢）';
      let rows = '<tr class="hub"><td>（空）</td><td>'+esc(d.host)+' ★中枢</td><td>本机</td><td>-</td><td>-</td></tr>';
      for(const a of on){
        rows += '<tr><td>'+esc(a.id)+'</td><td>'+esc(a.hostname)+'</td><td>'+esc(a.os)+'</td><td>'+esc(a.user)+'</td><td class="pending">'+(a.pending||0)+'</td></tr>';
      }
      document.getElementById('devices').innerHTML =
        on.length||d.running
          ? '<table><tr><th>agent_id</th><th>主机名</th><th>系统</th><th>用户</th><th>队列</th></tr>'+rows+'</table>'
          : '<div class="empty">中枢未启动</div>';
    }
    window.addEventListener('message', e => render(e.data));
    document.getElementById('copyBoot').onclick = () => vscode.postMessage({type:'copyBootstrap'});
    document.getElementById('copyToken').onclick = () => vscode.postMessage({type:'copyToken'});
    document.getElementById('copyDoc').onclick = () => vscode.postMessage({type:'copyDoc'});
    document.getElementById('openDoc').onclick = () => vscode.postMessage({type:'openDoc'});
    vscode.postMessage({type:'ready'});
  </script>
</body></html>`;
}

function showPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel("daoRemotePanel", "☰ DAO 中枢状态台", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString("hex");
  panel.webview.html = panelHtml(nonce);
  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || !m.type) return;
    if (m.type === "ready") {
      panel.webview.postMessage(deviceState());
    } else if (m.type === "copyBootstrap") {
      await vscode.env.clipboard.writeText(deviceState().bootstrap);
      vscode.window.showInformationMessage("已复制被控端一行接入指令");
    } else if (m.type === "copyToken") {
      if (!hub) return vscode.window.showWarningMessage("中枢未启动");
      await vscode.env.clipboard.writeText(hub.token);
      vscode.window.showInformationMessage("已复制中枢 Token");
    } else if (m.type === "copyDoc") {
      if (!hub) return vscode.window.showWarningMessage("中枢未启动");
      await vscode.env.clipboard.writeText(buildCloudDoc(hub));
      vscode.window.showInformationMessage("已复制云端文档（含所有在线设备与操作逻辑）");
    } else if (m.type === "openDoc") {
      const content = hub ? buildCloudDoc(hub) : infoMarkdown();
      const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
  }, null, context.subscriptions);
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
  statusItem.command = "daoRemote.showPanel";
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
  register(context, "daoRemote.showPanel", () => showPanel(context));
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
