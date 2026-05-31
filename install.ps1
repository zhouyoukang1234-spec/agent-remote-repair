# ╔══════════════════════════════════════════════════════════════╗
# ║  道 · Zero-Cost Public Tunnel — 一键安装                    ║
# ║  道法自然 · 万法归宗 · 无为无不为                            ║
# ║                                                              ║
# ║  Windows: irm https://raw.githubusercontent.com/             ║
# ║    zhouyoukang1234-spec/agent-remote-repair/main/install.ps1 | iex   ║
# ║                                                              ║
# ║  自动: Node.js检测/安装 → 项目下载 → 依赖安装 → 启动        ║
# ║  零成本: 无需Git · 无需域名 · 无需注册 · 无需配置            ║
# ╚══════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # 加速Invoke-WebRequest

$REPO_ZIP = "https://github.com/zhouyoukang1234-spec/agent-remote-repair/archive/refs/heads/main.zip"
$REPO_ZIP_MIRRORS = @(
    $REPO_ZIP,
    "https://ghfast.top/$REPO_ZIP",
    "https://gh-proxy.com/$REPO_ZIP"
)
$INSTALL_DIR = "$env:USERPROFILE\dao-remote"
$NODE_MIN_VERSION = [version]"18.0.0"

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   道 · Zero-Cost Public Tunnel Installer             ║" -ForegroundColor Cyan
Write-Host "  ║   道法自然 · 万法归宗 · 无为无不为                   ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ═══════════════════════════════════════════════════════════
# ① Node.js — 上善若水: 有则用之, 无则自取
# ═══════════════════════════════════════════════════════════

function Get-NodeVersion {
    try {
        $v = (node --version 2>$null)
        if ($v -match "^v(\d+\.\d+\.\d+)") { return [version]$Matches[1] }
    } catch {}
    return $null
}

function Install-NodeJS {
    Write-Host "  [1/4] Node.js 未找到或版本过低，自动安装中..." -ForegroundColor Yellow

    # 检测架构
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $nodeVersion = "22.16.0"  # LTS
    $msiUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-$arch.msi"
    $msiMirrors = @(
        $msiUrl,
        "https://npmmirror.com/mirrors/node/v$nodeVersion/node-v$nodeVersion-$arch.msi"
    )
    $msiPath = "$env:TEMP\node-install.msi"

    $downloaded = $false
    foreach ($url in $msiMirrors) {
        $src = if ($url -match "npmmirror") { "npmmirror" } else { "nodejs.org" }
        Write-Host "    尝试 $src ..." -ForegroundColor DarkGray
        try {
            Invoke-WebRequest -Uri $url -OutFile $msiPath -UseBasicParsing -TimeoutSec 120
            if ((Get-Item $msiPath).Length -gt 1MB) {
                $downloaded = $true
                Write-Host "    ✓ 下载完成 via $src" -ForegroundColor Green
                break
            }
        } catch {
            Write-Host "    × $src 失败: $_" -ForegroundColor DarkGray
        }
    }

    if (-not $downloaded) {
        Write-Host ""
        Write-Host "  [ERROR] Node.js 自动下载失败。请手动安装:" -ForegroundColor Red
        Write-Host "  https://nodejs.org/" -ForegroundColor Yellow
        Write-Host "  安装后重新运行本脚本。" -ForegroundColor Yellow
        return $false
    }

    Write-Host "    静默安装中 (需要管理员权限)..." -ForegroundColor Yellow
    try {
        # 尝试静默安装
        $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -PassThru -Verb RunAs
        if ($proc.ExitCode -eq 0) {
            Write-Host "    ✓ Node.js v$nodeVersion 安装成功" -ForegroundColor Green
            # 刷新PATH
            $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
            return $true
        } else {
            Write-Host "    静默安装返回 $($proc.ExitCode), 尝试交互安装..." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    静默安装需要管理员权限, 尝试交互安装..." -ForegroundColor Yellow
    }

    # 兜底: 交互式安装
    try {
        Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`"" -Wait
        $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
        $v = Get-NodeVersion
        if ($v) {
            Write-Host "    ✓ Node.js v$v 安装成功" -ForegroundColor Green
            return $true
        }
    } catch {}

    Write-Host "  [ERROR] Node.js 安装失败。请手动安装 https://nodejs.org/" -ForegroundColor Red
    return $false
}

$nodeVer = Get-NodeVersion
if ($nodeVer -and $nodeVer -ge $NODE_MIN_VERSION) {
    Write-Host "  [1/4] Node.js v$nodeVer ✓" -ForegroundColor Green
} else {
    $ok = Install-NodeJS
    if (-not $ok) { exit 1 }
    $nodeVer = Get-NodeVersion
    if (-not $nodeVer) {
        Write-Host "  [ERROR] Node.js 安装后仍未检测到。请重启终端后重试。" -ForegroundColor Red
        exit 1
    }
}

# ═══════════════════════════════════════════════════════════
# ② 下载项目 — 道法自然: 多源自适应, 无需Git
# ═══════════════════════════════════════════════════════════

Write-Host "  [2/4] 下载项目到 $INSTALL_DIR ..." -ForegroundColor Yellow

$zipPath = "$env:TEMP\dao-remote.zip"
$downloaded = $false

foreach ($url in $REPO_ZIP_MIRRORS) {
    $src = if ($url -match "ghfast") { "镜像1" } elseif ($url -match "gh-proxy") { "镜像2" } else { "GitHub" }
    Write-Host "    尝试 $src ..." -ForegroundColor DarkGray
    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
        if ((Get-Item $zipPath).Length -gt 10KB) {
            $downloaded = $true
            Write-Host "    ✓ 下载完成 via $src" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "    × $src 失败: $_" -ForegroundColor DarkGray
    }
}

if (-not $downloaded) {
    Write-Host "  [ERROR] 项目下载失败。检查网络连接后重试。" -ForegroundColor Red
    exit 1
}

# 解压 (覆盖旧版)
$extractDir = "$env:TEMP\dao-remote-extract"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

# 找到解压后的目录 (GitHub ZIP 内有一层 repo-branch/ 目录)
$innerDir = Get-ChildItem $extractDir -Directory | Select-Object -First 1
if (-not $innerDir) {
    Write-Host "  [ERROR] 解压失败" -ForegroundColor Red
    exit 1
}

# 如果目标已存在, 保留 .dao-remote/ (身份密钥) 和 bin/ (cloudflared)
$preserveDirs = @(".dao-remote", "bin", "node_modules")
foreach ($d in $preserveDirs) {
    $src = Join-Path $INSTALL_DIR $d
    $bak = Join-Path $env:TEMP "dao-preserve-$d"
    if (Test-Path $src) {
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        Move-Item $src $bak -Force
    }
}

# 移动到目标目录
if (Test-Path $INSTALL_DIR) { Remove-Item $INSTALL_DIR -Recurse -Force -ErrorAction SilentlyContinue }
Move-Item $innerDir.FullName $INSTALL_DIR -Force

# 恢复保留目录
foreach ($d in $preserveDirs) {
    $bak = Join-Path $env:TEMP "dao-preserve-$d"
    $dst = Join-Path $INSTALL_DIR $d
    if (Test-Path $bak) {
        Move-Item $bak $dst -Force
    }
}

# 清理
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "    ✓ 项目已安装到 $INSTALL_DIR" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════
# ③ 安装依赖 — 无为: npm install 只需执行一次
# ═══════════════════════════════════════════════════════════

Write-Host "  [3/4] 安装依赖..." -ForegroundColor Yellow

Push-Location $INSTALL_DIR
try {
    # 设置npm镜像 (加速中国大陆用户)
    $testChina = $false
    try {
        $r = Invoke-WebRequest -Uri "https://registry.npmmirror.com" -TimeoutSec 3 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($r.StatusCode -eq 200) { $testChina = $true }
    } catch {}

    if ($testChina) {
        Write-Host "    检测到国内网络, 使用 npmmirror 加速..." -ForegroundColor DarkGray
        npm install --registry=https://registry.npmmirror.com 2>&1 | Out-Null
    } else {
        npm install 2>&1 | Out-Null
    }

    if (Test-Path (Join-Path $INSTALL_DIR "node_modules\ws")) {
        Write-Host "    ✓ 依赖安装完成" -ForegroundColor Green
    } else {
        Write-Host "    重试安装..." -ForegroundColor Yellow
        npm install 2>&1 | Out-Null
    }
} finally {
    Pop-Location
}

# ═══════════════════════════════════════════════════════════
# ④ 启动 — 三生万物: Hub + Relay + Tunnel 一键涌现
# ═══════════════════════════════════════════════════════════

Write-Host "  [4/4] 启动 道 · 远程中枢..." -ForegroundColor Yellow
Write-Host ""

Set-Location $INSTALL_DIR
node dao.js
