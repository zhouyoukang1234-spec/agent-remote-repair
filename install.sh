#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  道 · Zero-Cost Public Tunnel — 一键安装 (Linux/macOS)      ║
# ║  道法自然 · 万法归宗 · 无为无不为                            ║
# ║                                                              ║
# ║  curl -fsSL https://raw.githubusercontent.com/               ║
# ║    zhouyoukang1234-spec/agent-remote-repair/main/install.sh | bash    ║
# ║                                                              ║
# ║  自动: Node.js检测 → 项目下载 → 依赖安装 → 启动             ║
# ║  零成本: 无需Git · 无需域名 · 无需注册 · 无需配置            ║
# ╚══════════════════════════════════════════════════════════════╝

set -e

REPO_ZIP="https://github.com/zhouyoukang1234-spec/agent-remote-repair/archive/refs/heads/main.zip"
INSTALL_DIR="$HOME/dao-remote"
NODE_MIN=18

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║   道 · Zero-Cost Public Tunnel Installer             ║"
echo "  ║   道法自然 · 万法归宗 · 无为无不为                   ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════
# ① Node.js — 上善若水: 有则用之, 无则提示
# ═══════════════════════════════════════════════════════════

check_node() {
    if command -v node &>/dev/null; then
        local ver
        ver=$(node -v | sed 's/^v//' | cut -d. -f1)
        if [ "$ver" -ge "$NODE_MIN" ] 2>/dev/null; then
            echo "  [1/4] Node.js $(node -v) ✓"
            return 0
        fi
    fi
    return 1
}

install_node() {
    echo "  [1/4] Node.js 未找到或版本过低，尝试自动安装..."

    # 尝试 nvm — nvm 是 shell function 非 binary, command -v 无法识别
    # 必须先 source 用户 shell 初始化文件再检测
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh"
        if command -v nvm &>/dev/null; then
            nvm install --lts && nvm use --lts
            return $?
        fi
    fi

    # 尝试包管理器
    if [ "$(uname)" = "Darwin" ]; then
        if command -v brew &>/dev/null; then
            echo "    使用 Homebrew 安装..."
            brew install node
            return $?
        fi
    else
        # Linux: 尝试 NodeSource
        if command -v apt-get &>/dev/null; then
            echo "    使用 apt 安装 (可能需要 sudo)..."
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt-get install -y nodejs
            return $?
        elif command -v dnf &>/dev/null; then
            echo "    使用 dnf 安装..."
            curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
            sudo dnf install -y nodejs
            return $?
        fi
    fi

    echo ""
    echo "  [ERROR] 无法自动安装 Node.js。请手动安装:"
    echo "  https://nodejs.org/"
    echo "  或: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    return 1
}

if ! check_node; then
    install_node || exit 1
    check_node || { echo "  [ERROR] Node.js 安装后仍未检测到。请重启终端后重试。"; exit 1; }
fi

# ═══════════════════════════════════════════════════════════
# ② 下载项目 — 道法自然: 无需Git, ZIP直下
# ═══════════════════════════════════════════════════════════

echo "  [2/4] 下载项目到 $INSTALL_DIR ..."

TMP_ZIP="/tmp/dao-remote.zip"
TMP_EXTRACT="/tmp/dao-remote-extract"

MIRRORS=("$REPO_ZIP" "https://ghfast.top/$REPO_ZIP" "https://gh-proxy.com/$REPO_ZIP")
downloaded=false

for url in "${MIRRORS[@]}"; do
    echo "    尝试: ${url:0:60}..."
    if curl -fsSL --connect-timeout 15 --max-time 120 -o "$TMP_ZIP" "$url" 2>/dev/null; then
        # 道·去伪: 10KB 门槛过滤 CDN 异常空返回 / 错误页面
        size=$(wc -c < "$TMP_ZIP" 2>/dev/null || echo 0)
        if [ "$size" -gt 10240 ]; then
            downloaded=true
            echo "    ✓ 下载完成 ($size bytes)"
            break
        else
            echo "    × 下载文件过小 ($size bytes), 重试下一镜像..."
        fi
    fi
done

if [ "$downloaded" = false ]; then
    echo "  [ERROR] 项目下载失败。检查网络连接后重试。"
    exit 1
fi

# 道·柔: 兜底 unzip/bsdtar/jar, 不强求单一工具
rm -rf "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"
if command -v unzip &>/dev/null; then
    unzip -q "$TMP_ZIP" -d "$TMP_EXTRACT"
elif command -v bsdtar &>/dev/null; then
    bsdtar -xf "$TMP_ZIP" -C "$TMP_EXTRACT"
elif command -v jar &>/dev/null; then
    (cd "$TMP_EXTRACT" && jar xf "$TMP_ZIP")
else
    echo "  [ERROR] 需要 unzip 或 bsdtar 或 jar 来解压. 请先安装: apt install unzip"
    exit 1
fi

INNER_DIR=$(find "$TMP_EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -z "$INNER_DIR" ]; then
    echo "  [ERROR] 解压失败"
    exit 1
fi

# 保留身份密钥和已下载的二进制
for d in .dao-remote bin node_modules; do
    if [ -d "$INSTALL_DIR/$d" ]; then
        mv "$INSTALL_DIR/$d" "/tmp/dao-preserve-$d" 2>/dev/null || true
    fi
done

rm -rf "$INSTALL_DIR"
mv "$INNER_DIR" "$INSTALL_DIR"

for d in .dao-remote bin node_modules; do
    if [ -d "/tmp/dao-preserve-$d" ]; then
        mv "/tmp/dao-preserve-$d" "$INSTALL_DIR/$d"
    fi
done

rm -f "$TMP_ZIP"
rm -rf "$TMP_EXTRACT"

echo "    ✓ 项目已安装到 $INSTALL_DIR"

# ═══════════════════════════════════════════════════════════
# ③ 安装依赖
# ═══════════════════════════════════════════════════════════

echo "  [3/4] 安装依赖..."
cd "$INSTALL_DIR"

# 检测中国网络加速
if curl -sI --connect-timeout 2 https://registry.npmmirror.com >/dev/null 2>&1; then
    echo "    检测到国内网络, 使用 npmmirror 加速..."
    npm install --registry=https://registry.npmmirror.com 2>/dev/null
else
    npm install 2>/dev/null
fi

if [ -d "$INSTALL_DIR/node_modules/ws" ]; then
    echo "    ✓ 依赖安装完成"
else
    echo "    重试安装..."
    npm install
fi

# ═══════════════════════════════════════════════════════════
# ④ 启动 — 三生万物
# ═══════════════════════════════════════════════════════════

echo "  [4/4] 启动 道 · 远程中枢..."
echo ""

cd "$INSTALL_DIR"
node dao.js
