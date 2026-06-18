// ╔══════════════════════════════════════════════════════════╗
// ║  道 · 隧道 (dao_tunnel.js)                              ║
// ║  水善利万物而不争 — 自适应公网穿透                        ║
// ║                                                          ║
// ║  探测优先级: cloudflared → ngrok → SSH(localhost.run)    ║
// ║  全部失败则LAN模式。断线自动重连，无缝切换。              ║
// ║  用户无需配置: 零域名 · 零注册 · 零费用                  ║
// ╚══════════════════════════════════════════════════════════╝

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

let _tunnelUrl = null;
let _tunnelProcess = null;
let _tunnelMethod = null; // 'cloudflared' | 'ngrok' | 'ssh'
let _reconnectAttempt = 0;
let _onUrlCallbacks = [];
let _stopped = false;
let _localPort = 0;

// ═══════════════════════════════════════════════════════════
// 二进制探测 — 道法自然: 有什么用什么, 不假设任何存在
// ═══════════════════════════════════════════════════════════

var _projectRoot = path.join(__dirname, "..");

function _findBinary(name) {
  var isWin = process.platform === "win32";
  var exe = isWin ? name + ".exe" : name;
  // PATH
  try {
    var cmd = isWin ? "where " + exe + " 2>nul" : "which " + name;
    var result = execSync(cmd, {
      timeout: 3000,
      windowsHide: true,
      encoding: "utf-8",
    }).trim();
    if (result) return result.split("\n")[0].trim();
  } catch (e) {}
  // Local directory (project root + remote-agent)
  var local = path.join(_projectRoot, exe);
  try {
    if (fs.existsSync(local) && fs.statSync(local).size > 100000) return local;
  } catch (e) {}
  var local2 = path.join(__dirname, exe);
  try {
    if (fs.existsSync(local2) && fs.statSync(local2).size > 100000)
      return local2;
  } catch (e) {}
  // bin/ subdirectory
  var local3 = path.join(_projectRoot, "bin", exe);
  try {
    if (fs.existsSync(local3) && fs.statSync(local3).size > 100000)
      return local3;
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// 自动下载 cloudflared — 上善若水: 无则自取, 用户无感
// 零注册 · 零费用 · Quick Tunnel 自动获取 HTTPS 公网 URL
// ═══════════════════════════════════════════════════════════

function _getCloudflaredUrls() {
  var p = process.platform;
  var a = process.arch;
  var file;
  if (p === "win32") {
    file =
      a === "arm64"
        ? "cloudflared-windows-arm64.exe"
        : "cloudflared-windows-amd64.exe";
  } else if (p === "darwin") {
    file =
      a === "arm64"
        ? "cloudflared-darwin-arm64.tgz"
        : "cloudflared-darwin-amd64.tgz";
  } else {
    if (a === "arm64" || a === "aarch64") file = "cloudflared-linux-arm64";
    else if (a === "arm") file = "cloudflared-linux-arm";
    else file = "cloudflared-linux-amd64";
  }
  var gh =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/" +
    file;
  // 道法自然: 多源自适应 — GitHub直连 + 镜像(中国大陆)
  return [
    gh,
    "https://ghfast.top/" + gh,
    "https://gh-proxy.com/" + gh,
    "https://mirror.ghproxy.com/" + gh,
  ];
}

function _downloadFile(url, destPath, maxRedirects, timeoutMs) {
  maxRedirects = maxRedirects || 5;
  timeoutMs = timeoutMs || 60000;
  return new Promise(function (resolve, reject) {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    var mod = url.startsWith("https") ? https : http;
    mod
      .get(url, { timeout: timeoutMs }, function (res) {
        // Follow redirects (GitHub uses 302)
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return _downloadFile(res.headers.location, destPath, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        var total = parseInt(res.headers["content-length"] || "0", 10);
        var downloaded = 0;
        var lastLog = 0;
        var file = fs.createWriteStream(destPath);
        res.on("data", function (chunk) {
          downloaded += chunk.length;
          var now = Date.now();
          if (total > 0 && now - lastLog > 3000) {
            lastLog = now;
            var pct = Math.floor((downloaded / total) * 100);
            console.log(
              "[tunnel:download] cloudflared " +
                pct +
                "% (" +
                Math.floor(downloaded / 1048576) +
                "MB)",
            );
          }
        });
        res.pipe(file);
        file.on("finish", function () {
          file.close(function () {
            resolve(destPath);
          });
        });
        file.on("error", function (err) {
          fs.unlink(destPath, function () {});
          reject(err);
        });
      })
      .on("error", reject)
      .on("timeout", function () {
        reject(new Error("Download timeout"));
      });
  });
}

async function _autoDownloadCloudflared() {
  var isWin = process.platform === "win32";
  var exe = isWin ? "cloudflared.exe" : "cloudflared";
  var binDir = path.join(_projectRoot, "bin");
  var destPath = path.join(binDir, exe);

  // Already downloaded?
  try {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100000) {
      return destPath;
    }
  } catch (e) {}

  var urls = _getCloudflaredUrls();
  console.log(
    "[tunnel:download] cloudflared 未找到，自动下载中 (" +
      urls.length +
      " 源)...",
  );

  try {
    fs.mkdirSync(binDir, { recursive: true });
  } catch (e) {}

  var isTgz = urls[0].endsWith(".tgz");
  var dlPath = isTgz ? destPath + ".tgz" : destPath;

  // 道法自然: 多源顺序尝试 — GitHub直连 + 多个镜像
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i];
    var srcName = i === 0 ? "GitHub" : "镜像" + i;
    console.log(
      "[tunnel:download] 尝试 " + srcName + ": " + url.substring(0, 80) + "...",
    );
    try {
      await _downloadFile(url, dlPath);

      if (isTgz) {
        execSync(
          "tar -xzf " +
            JSON.stringify(dlPath) +
            " -C " +
            JSON.stringify(binDir),
          { timeout: 30000, windowsHide: true },
        );
        try {
          fs.unlinkSync(dlPath);
        } catch (e) {}
      }

      if (!isWin) {
        try {
          fs.chmodSync(destPath, 0o755);
        } catch (e) {}
      }

      var size = fs.statSync(destPath).size;
      if (size < 100000) {
        console.log("[tunnel:download] 文件过小 (" + size + "B), 跳过");
        try {
          fs.unlinkSync(destPath);
        } catch (e) {}
        continue;
      }
      console.log(
        "[tunnel:download] ✓ cloudflared 下载完成 (" +
          Math.floor(size / 1048576) +
          "MB) via " +
          srcName,
      );
      return destPath;
    } catch (err) {
      console.log("[tunnel:download] " + srcName + " 失败: " + err.message);
      try {
        fs.unlinkSync(dlPath);
      } catch (e) {}
    }
  }
  console.log("[tunnel:download] 所有源均失败，跳过cloudflared");
  return null;
}

function _checkBinaryAsync(name) {
  return new Promise(function (resolve) {
    try {
      var proc = spawn(name, name === "ssh" ? ["-V"] : ["version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      proc.on("error", function () {
        resolve(false);
      });
      proc.on("close", function () {
        resolve(true);
      });
      setTimeout(function () {
        try {
          proc.kill();
        } catch (e) {}
        resolve(false);
      }, 5000);
    } catch (e) {
      resolve(false);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// URL提取 — 从子进程输出中解析公网URL
// ═══════════════════════════════════════════════════════════

function _notifyUrl(url) {
  if (url && url !== _tunnelUrl) {
    _tunnelUrl = url;
    _reconnectAttempt = 0;
    console.log("[tunnel:" + _tunnelMethod + "] Public URL: " + _tunnelUrl);
    for (var j = 0; j < _onUrlCallbacks.length; j++) {
      try {
        _onUrlCallbacks[j](_tunnelUrl);
      } catch (e) {}
    }
  }
}

function _extractUrl(line) {
  var match = line.match(/(https:\/\/[a-z0-9][\w.-]+\.[a-z]{2,})/i);
  if (!match) return null;
  var url = match[1];
  // 过滤服务域名本身 — 只要分配的子域名URL
  var dominated = [
    "https://localhost.run",
    "https://ngrok.com",
    "https://cloudflare.com",
  ];
  for (var i = 0; i < dominated.length; i++) {
    if (url === dominated[i] || url === dominated[i] + "/") return null;
  }
  return url;
}

// ═══════════════════════════════════════════════════════════
// 重连机制 — 反者道之动: 断开即重生
// ═══════════════════════════════════════════════════════════

function _scheduleReconnect() {
  if (_stopped) return;
  var oldUrl = _tunnelUrl;
  _tunnelUrl = null;
  _tunnelProcess = null;
  if (oldUrl) console.log("[tunnel] Disconnected (was: " + oldUrl + ")");
  _reconnectAttempt++;
  var delay = Math.min(60000, 5000 * Math.pow(2, _reconnectAttempt - 1));
  console.log(
    "[tunnel] Reconnecting in " +
      delay / 1000 +
      "s (#" +
      _reconnectAttempt +
      ")...",
  );
  setTimeout(function () {
    _startBest(_localPort);
  }, delay);
}

// ═══════════════════════════════════════════════════════════
// Cloudflared — 零注册Quick Tunnel (最优: 稳定+HTTPS+自动)
// ═══════════════════════════════════════════════════════════

function _startCloudflared(localPort, cfPath) {
  _tunnelMethod = "cloudflared";
  console.log("[tunnel:cloudflared] Starting quick tunnel → :" + localPort);

  // 道法自然: 默认 http2 — 兼容封禁 UDP/QUIC 的网络(企业/校园/部分云)。
  // 需要 quic 可设 DAO_CF_PROTOCOL=quic 覆盖。
  var proto = process.env.DAO_CF_PROTOCOL || "http2";
  _tunnelProcess = spawn(
    cfPath,
    ["tunnel", "--url", "http://localhost:" + localPort, "--no-autoupdate", "--protocol", proto],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  // cloudflared outputs URL on stderr
  _tunnelProcess.stderr.on("data", function (data) {
    var lines = data.toString().split("\n");
    for (var i = 0; i < lines.length; i++) {
      var url = _extractUrl(lines[i]);
      if (url && url.includes("trycloudflare.com")) {
        _notifyUrl(url);
      } else {
        var line = lines[i].trim();
        if (
          line &&
          !line.includes("INF") &&
          !line.includes("Thank you") &&
          !line.includes("cloudflare")
        )
          console.log("[tunnel:cf]", line);
      }
    }
  });
  _tunnelProcess.stdout.on("data", function (data) {
    var url = _extractUrl(data.toString());
    if (url) _notifyUrl(url);
  });
  _tunnelProcess.on("close", _scheduleReconnect);
  _tunnelProcess.on("error", function (err) {
    console.log("[tunnel:cloudflared] Error:", err.message);
    _scheduleReconnect();
  });
}

// ═══════════════════════════════════════════════════════════
// Ngrok — 需要注册但稳定 (次优)
// ═══════════════════════════════════════════════════════════

function _startNgrok(localPort, ngrokPath) {
  _tunnelMethod = "ngrok";
  console.log("[tunnel:ngrok] Starting tunnel → :" + localPort);

  _tunnelProcess = spawn(
    ngrokPath,
    ["http", String(localPort), "--log", "stdout", "--log-format", "term"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  _tunnelProcess.stdout.on("data", function (data) {
    var lines = data.toString().split("\n");
    for (var i = 0; i < lines.length; i++) {
      var url = _extractUrl(lines[i]);
      if (url && url.includes("ngrok")) _notifyUrl(url);
    }
  });
  _tunnelProcess.stderr.on("data", function (data) {
    var url = _extractUrl(data.toString());
    if (url) _notifyUrl(url);
  });
  _tunnelProcess.on("close", _scheduleReconnect);
  _tunnelProcess.on("error", function (err) {
    console.log("[tunnel:ngrok] Error:", err.message);
    _scheduleReconnect();
  });
}

// ═══════════════════════════════════════════════════════════
// SSH → localhost.run — 免注册免安装 (兜底)
// ═══════════════════════════════════════════════════════════

function _startSSH(localPort) {
  _tunnelMethod = "ssh";
  console.log("[tunnel:ssh] Connecting to localhost.run → :" + localPort);

  _tunnelProcess = spawn(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "LogLevel=ERROR",
      "-R",
      "80:localhost:" + localPort,
      "nokey@localhost.run",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  _tunnelProcess.stdout.on("data", function (data) {
    var lines = data.toString().split("\n");
    for (var i = 0; i < lines.length; i++) {
      var url = _extractUrl(lines[i].trim());
      if (url) _notifyUrl(url);
    }
  });
  _tunnelProcess.stderr.on("data", function (data) {
    var line = data.toString().trim();
    if (
      line &&
      !line.includes("Warning:") &&
      !line.includes("Permanently added")
    ) {
      console.log("[tunnel:ssh]", line);
    }
  });
  _tunnelProcess.on("close", _scheduleReconnect);
  _tunnelProcess.on("error", function (err) {
    console.log("[tunnel:ssh] Error:", err.message);
    _scheduleReconnect();
  });
}

// ═══════════════════════════════════════════════════════════
// 自适应选择 — 上善若水: 有cloudflared用cloudflared, 有ngrok用
// ngrok, 有SSH用SSH, 全无则LAN
// ═══════════════════════════════════════════════════════════

async function _startBest(localPort) {
  if (_stopped) return;

  // ① cloudflared 本地探测 (最优)
  var cfPath = _findBinary("cloudflared");
  if (cfPath) {
    _startCloudflared(localPort, cfPath);
    return;
  }

  // ② ngrok (次优)
  var ngrokPath = _findBinary("ngrok");
  if (ngrokPath) {
    _startNgrok(localPort, ngrokPath);
    return;
  }

  // ③ 自动下载 cloudflared — 道法自然: 无则自取
  // 零注册 · 零费用 · Quick Tunnel HTTPS
  var downloaded = await _autoDownloadCloudflared();
  if (downloaded) {
    _startCloudflared(localPort, downloaded);
    return;
  }

  // ④ SSH → localhost.run (最终兜底)
  var hasSSH = await _checkBinaryAsync("ssh");
  if (hasSSH) {
    _startSSH(localPort);
    return;
  }

  console.log("[tunnel] 无可用隧道工具且自动下载失败");
  console.log("[tunnel] 仅局域网模式 — 检查网络连接后重启即可自动重试");
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

async function start(localPort) {
  _stopped = false;
  _localPort = localPort;
  await _startBest(localPort);
  return true;
}

function stop() {
  _stopped = true;
  if (_tunnelProcess) {
    try {
      _tunnelProcess.kill();
    } catch (e) {}
    _tunnelProcess = null;
  }
  _tunnelUrl = null;
}

function onUrl(callback) {
  _onUrlCallbacks.push(callback);
  if (_tunnelUrl) {
    try {
      callback(_tunnelUrl);
    } catch (e) {}
  }
}

function waitForUrl(timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  if (_tunnelUrl) return Promise.resolve(_tunnelUrl);
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    onUrl(function (url) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
}

module.exports = {
  start: start,
  stop: stop,
  onUrl: onUrl,
  waitForUrl: waitForUrl,
  get url() {
    return _tunnelUrl;
  },
  get active() {
    return !!_tunnelProcess;
  },
  get method() {
    return _tunnelMethod;
  },
};
