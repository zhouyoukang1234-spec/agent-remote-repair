// ═══════════════════════════════════════════════════════════
// 道 · 自检 — 三明治端到端契约测试（无需外网/隧道）
//   操控端 → 中枢(本机) → 被控端(模拟) 的 队列/轮询/结果 全链路
// ═══════════════════════════════════════════════════════════
"use strict";
const http = require("http");
const { Hub, startServer, buildBootstrap } = require("./core");

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

  // 三明治核心：操控端 → 中枢 → 被控端 同步往返
  const routed = await api(BASE, "POST", "/api/exec-sync", { agent_id: "TEST-PC", cmd: "Get-Date", timeout: 10 }, TOKEN);
  ok("exec-sync routes to controlled-end and returns result", routed.status === 200 && routed.json.result.stdout.includes("TEST-PC ran: Get-Date"));

  const unknown = await api(BASE, "POST", "/api/exec-sync", { agent_id: "no-such-agent", cmd: "x", timeout: 2 }, TOKEN);
  ok("exec-sync to unknown agent → 404", unknown.status === 404);

  const bc = await api(BASE, "POST", "/api/broadcast", { cmd: "whoami" }, TOKEN);
  ok("broadcast delivers to agents", bc.json.ok && bc.json.delivered.length === 1);

  const boot = await api(BASE, "GET", "/api/bootstrap.ps1");
  ok("bootstrap.ps1 served, embeds connect+poll loop", boot.status === 200 && boot.raw.includes("/api/connect") && boot.raw.includes("/api/poll"));
  ok("buildBootstrap embeds the hub url", buildBootstrap("https://example.test").includes("https://example.test"));

  running = false;
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
