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

const { Hub, startServer, connectRelay, buildCloudDoc } = require("./core");
const tunnel = require("./tunnel");

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
  const md = buildCloudDoc(hub);
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
