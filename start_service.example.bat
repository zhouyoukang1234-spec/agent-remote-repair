@echo off
title Agent Remote Repair v7.1
echo ============================================
echo   Agent Remote Repair Hub v7.1
echo   dao.js 统一启动 (Hub + Relay + Tunnel)
echo ============================================
echo.
echo   小白推荐: PowerShell 一行启动 (自动装Node):
echo   irm https://raw.githubusercontent.com/zhouyoukang1234-spec/agent-remote-repair/main/install.ps1 ^| iex
echo.

:: 前置检查: Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found!
    echo [TIP] 使用 PowerShell 一行命令自动安装:
    echo   irm https://raw.githubusercontent.com/zhouyoukang1234-spec/agent-remote-repair/main/install.ps1 ^| iex
    pause
    exit /b 1
)

:: 安装依赖 (首次)
if not exist "%~dp0node_modules" (
    echo [1/2] Installing dependencies...
    cd /d %~dp0 && npm install
)

:: 启动 (dao.js 自动管理 Hub + Relay + Tunnel)
echo [2/2] Starting dao.js (Hub + Relay + Tunnel)...
echo.
cd /d %~dp0 && node dao.js

:: dao.js 退出时提示
echo.
echo ============================================
echo   Services stopped.
echo ============================================
pause
