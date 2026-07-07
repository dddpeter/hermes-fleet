# Hermes Fleet 部署手册

> 面向 Hermes Fleet（hermes-web-ui）的安装、配置、升级与故障排查指南。
> 本文档适用于将 Hermes Fleet 部署到远程 Linux 服务器（非 Docker 方式）。

---

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 安装 Hermes Agent](#2-安装-hermes-agent)
- [3. 安装 Hermes Fleet](#3-安装-hermes-fleet)
- [4. 配置](#4-配置)
  - [4.1 环境变量](#41-环境变量)
  - [4.2 Profile 配置](#42-profile-配置)
  - [4.3 敏感信息隔离](#43-敏感信息隔离)
- [5. systemd 服务（推荐）](#5-systemd-服务推荐)
- [6. 验证清单](#6-验证清单)
- [7. 升级流程](#7-升级流程)
- [8. 故障排查](#8-故障排查)

---

## 1. 环境要求

| 组件 | 最低版本 | 说明 |
|------|---------|------|
| **Node.js** | ≥ 23.0.0 | npm >= 10，建议使用 nvm 管理 |
| **Python** | ≥ 3.10 | Agent Bridge 依赖（hermes-web-ui 会 spawn Python 子进程） |
| **Hermes Agent** | 最新版 | 通过 uv 或 pip 安装，提供 CLI + Agent 运行时 |

### 检查命令

```bash
node --version     # >= v23.0.0
npm --version      # >= 10
python3 --version  # >= 3.10
hermes --version   # 最新版
```

---

## 2. 安装 Hermes Agent

Hermes Fleet 依赖 Hermes Agent CLI 来启动和管理 Gateway 进程。

### 方式一：uv（推荐）

```bash
# 安装 uv（如果没有）
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env

# 安装 hermes-agent
uv tool install hermes-agent

# 验证
~/.local/share/uv/tools/hermes-agent/bin/hermes --version
```

### 方式二：pip

```bash
pip install hermes-agent
hermes --version
```

---

## 3. 安装 Hermes Fleet

### 3.1 从 npm 安装（官方推荐）

```bash
npm install -g hermes-web-ui
hermes-web-ui --version
```

### 3.2 从源码打包安装（开发/私有部署）

当需要部署自定义版本时，从源码打包：

```bash
# 克隆仓库
git clone https://gitee.com/dddpeter/hermes-fleet.git
cd hermes-fleet

# ⚠️ 【关键】先删除 dist 再打包
# npm pack 的 prepare 脚本逻辑是 [ -d dist ] || npm run build
# 如果 dist 目录已存在，会跳过构建，导致包内代码是旧的
rm -rf dist
npm pack

# 生成的 .tgz 文件可安装到任意机器
ls hermes-web-ui-*.tgz
```

将 `.tgz` 传输到目标服务器后安装：

```bash
# ⚠️ 如果使用 nvm 管理 Node.js，必须先激活 nvm 环境
export NVM_DIR=$HOME/.nvm && source $NVM_DIR/nvm.sh

# 安装
npm install -g /path/to/hermes-web-ui-x.y.z.tgz

# 验证
hermes-web-ui --version
```

> **坑点**：
> - `rm -rf dist` 是必须的。如果 dist 存在，`npm pack` 不会重新 build，包内 JS hash 和 shasum 都不变，部署后版本号虽然正确但代码是旧的。
> - 必须在 nvm 环境下执行 `npm install -g`，否则会报权限错误：`The operation was rejected by your operating system`。

---

## 4. 配置

### 4.1 环境变量

Hermes Fleet 的运行依赖以下关键环境变量：

#### HERMES_BIN（必配）

Hermes Agent CLI 的完整路径。hermes-web-ui 通过此路径 spawn Gateway 子进程。

```bash
# uv 安装
export HERMES_BIN=$HOME/.local/share/uv/tools/hermes-agent/bin/hermes

# pip 安装（通常在 PATH 中，不需要显式设置）
export HERMES_BIN=$(which hermes)
```

**不配置的后果**：`spawn hermes ENOENT`，所有 Gateway 启动失败。

#### HERMES_AGENT_ROOT（必配）

Agent Bridge 是 Python 进程，需要定位 Hermes Agent 的 `run_agent.py`。默认搜索路径可能覆盖不到 uv 安装位置。

```bash
# 找到 run_agent.py 的实际位置
find $HOME/.local/share/uv/tools/hermes-agent -name 'run_agent.py'
# 例如：/home/user/.local/share/uv/tools/hermes-agent/lib/python3.14/site-packages/run_agent.py

# agent_root = run_agent.py 所在目录（即 site-packages）
export HERMES_AGENT_ROOT=/home/user/.local/share/uv/tools/hermes-agent/lib/python3.14/site-packages
```

**不配置的后果**：Agent Bridge 启动后立即 exit code 1，无法创建 Unix socket `/tmp/hermes-agent-bridge.sock`，导致所有 Agent 交互报错：
```
Error: Agent Bridge is not reachable: connect ENOENT configured endpoint
```

#### PATH

确保 `HERMES_BIN` 和 Node.js bin 目录在 PATH 中：

```bash
export PATH=$HOME/.nvm/versions/node/v$(node --version | cut -d. -f1-2)/bin:$HOME/.local/share/uv/tools/hermes-agent/bin:$PATH
```

### 4.2 Profile 配置

Hermes 使用 Profile 隔离不同环境（如不同用户、不同用途）。

#### 目录结构

```
~/.hermes/
├── .env              # 根级配置（= default profile）
├── config.yaml       # 全局配置
└── profiles/
    └── <name>/
        ├── config.yaml   # Profile 级配置
        └── .env           # Profile 级环境变量
```

> **注意**：default profile 就是根级 `~/.hermes/`，**不要** 创建 `~/.hermes/profiles/default/` 目录。

#### 端口分配

每个 Profile 的 API Server 独立端口，通过 `.env` 配置：

```bash
# 根级 ~/.hermes/.env（default profile）
API_SERVER_ENABLED=true
API_SERVER_PORT=8642
API_SERVER_KEY=<随机值，openssl rand -hex 32>

# 子 profile ~/.hermes/profiles/<name>/.env
API_SERVER_ENABLED=true
API_SERVER_PORT=8645
API_SERVER_KEY=<独立随机值>
```

> **铁律**：`API_SERVER_PORT` 和 `API_SERVER_KEY` **写在 `.env` 里**，不要写 `config.yaml`，避免两处配置冲突。

#### DM 开放策略（可选）

如果需要自动通过 pairing（无需审批），在各 `.env` 中添加：

```bash
# 对所有平台开放 DM
FEISHU_DM_POLICY=open
FEISHU_ALLOW_ALL_USERS=true
WEIXIN_DM_POLICY=open
WEIXIN_ALLOW_ALL_USERS=true
FEISHU_GROUP_POLICY=open
FEISHU_REQUIRE_MENTION=true
```

### 4.3 敏感信息隔离

部署到远端服务器时，**严禁** 携带以下凭据：

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BOT_WEBHOOK`
- `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `SLACK_BOT_TOKEN`
- 其他平台的 token、secret、API key

只同步通用配置：行为参数、端口、DM 策略、模型 URL。远端凭据独立配置。

---

## 5. systemd 服务（推荐）

使用 systemd --user 管理持久化运行，支持自动重启和开机自启。

### 5.1 创建服务文件

```bash
mkdir -p ~/.config/systemd/user
```

编辑 `~/.config/systemd/user/hermes-web-ui.service`：

```ini
[Unit]
Description=Hermes Web UI (hermes-fleet)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking

# ⚠️ 三个必须的环境变量（根据实际路径修改）
Environment=HERMES_BIN=/home/<user>/.local/share/uv/tools/hermes-agent/bin/hermes
Environment=HERMES_AGENT_ROOT=/home/<user>/.local/share/uv/tools/hermes-agent/lib/python3.14/site-packages
Environment=PATH=/home/<user>/.nvm/versions/node/v24.18.0/bin:/home/<user>/.local/share/uv/tools/hermes-agent/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

ExecStart=/home/<user>/.nvm/versions/node/v24.18.0/bin/hermes-web-ui start --port 6060
ExecStop=/home/<user>/.nvm/versions/node/v24.18.0/bin/hermes-web-ui stop
PIDFile=/home/<user>/.hermes-web-ui/server.pid
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

> **路径替换**：将上述所有 `/home/<user>` 替换为实际用户主目录。

### 5.2 启用并启动

```bash
# 允许用户服务在未登录时运行
loginctl enable-linger $(whoami)

# 加载配置
systemctl --user daemon-reload

# 开机自启
systemctl --user enable hermes-web-ui.service

# 启动
systemctl --user start hermes-web-ui.service

# 查看状态
systemctl --user status hermes-web-ui.service
```

### 5.3 常用管理命令

```bash
# 查看状态
systemctl --user status hermes-web-ui.service

# 重启
systemctl --user restart hermes-web-ui.service

# 停止
systemctl --user stop hermes-web-ui.service

# 查看日志
journalctl --user -u hermes-web-ui.service --no-pager -n 50
```

---

## 6. 验证清单

部署完成后，按以下顺序验证：

```bash
# ① 服务状态
systemctl --user status hermes-web-ui.service
# 期望：Active: active (running)

# ② HTTP 响应
curl -s -o /dev/null -w '%{http_code}' http://localhost:6060
# 期望：200

# ③ 版本确认
hermes-web-ui --version
# 期望：目标版本号

# ④ Agent Bridge socket
ls -la /tmp/hermes-agent-bridge.sock
# 期望：srwxrwxr-x（存在）
# 如果不存在 → 检查 HERMES_AGENT_ROOT 配置

# ⑤ Bridge 启动日志
grep 'agent bridge' ~/.hermes-web-ui/server.log | tail -3
# 期望最后一条：[bootstrap] agent bridge started
# 如果是 "failed to start" → 手动运行 bridge Python 脚本看报错

# ⑥ Gateway 进程
ps aux | grep 'hermes gateway' | grep -v grep
# 期望：至少一个 gateway run 进程

# ⑦ API Server 端口
ss -tlnp | grep -E '8642|8645|8646'
# 期望：对应端口在监听
```

---

## 7. 升级流程

### 7.1 从 npm 升级

```bash
systemctl --user stop hermes-web-ui.service

export NVM_DIR=$HOME/.nvm && source $NVM_DIR/nvm.sh
npm install -g hermes-web-ui@latest

hermes-web-ui --version  # 确认版本
systemctl --user start hermes-web-ui.service
```

### 7.2 从源码打包升级

```bash
# === 构建端（开发机） ===
cd hermes-fleet
rm -rf dist        # ⚠️ 必须
npm pack
scp hermes-web-ui-*.tgz user@server:/tmp/

# === 部署端 ===
systemctl --user stop hermes-web-ui.service

export NVM_DIR=$HOME/.nvm && source $NVM_DIR/nvm.sh
npm uninstall -g hermes-web-ui
npm install -g /tmp/hermes-web-ui-*.tgz

hermes-web-ui --version
systemctl --user start hermes-web-ui.service

# 等待 bridge 启动（约 15 秒）
sleep 15

# 验证
curl -s -o /dev/null -w '%{http_code}' http://localhost:6060
ls -la /tmp/hermes-agent-bridge.sock
grep 'agent bridge' ~/.hermes-web-ui/server.log | tail -3

# 清理
rm /tmp/hermes-web-ui-*.tgz
```

---

## 8. 故障排查

### 常见错误速查表

| 错误信息 | 根因 | 修复 |
|----------|------|------|
| `spawn hermes ENOENT` | `HERMES_BIN` 未设置或路径错误 | 设置 HERMES_BIN 环境变量指向 hermes 可执行文件 |
| `hermes-agent run_agent.py not found` | `HERMES_AGENT_ROOT` 未设置 | 设置 HERMES_AGENT_ROOT 指向包含 `run_agent.py` 的 site-packages 目录 |
| `Agent Bridge is not reachable: connect ENOENT` | Bridge socket 未创建（HERMES_AGENT_ROOT 缺失的下游表现） | 检查 HERMES_AGENT_ROOT，确认 socket 存在 |
| `agent bridge exited before ready code=1` | Python 环境问题或 agent_root 路径错误 | 手动运行 bridge 脚本查看完整 traceback |
| `API_SERVER_KEY is required` | `.env` 中未配置 | 在 profile `.env` 中添加 `API_SERVER_KEY=<随机值>` |
| `npm: The operation was rejected by your operating system` | npm 不在 nvm 环境中 | 先 `source ~/.nvm/nvm.sh` 再执行 npm |
| 远端版本号没变 / shasum 相同 | 打包时 dist 未删除 | `rm -rf dist && npm pack` 强制重建 |
| `Platform 'feishu' config validation failed` | 远端未配置飞书凭据 | 预期内（敏感信息隔离），不影响其他功能 |
| 服务启动后立即无法访问 | Bridge 需要约 15 秒启动 | 等待后再验证 |
| `Node.js version too old` | Node < 23.0.0 | 升级 Node.js（`nvm install 24`） |

### 手动诊断 Bridge

如果 Bridge 启动失败，手动运行脚本查看完整错误信息：

```bash
python3 <path-to-hermes-web-ui>/dist/server/agent-bridge/python/hermes_bridge.py 2>&1
```

### 诊断命令速查

```bash
# 服务状态
systemctl --user status hermes-web-ui.service

# 服务标准输出日志
journalctl --user -u hermes-web-ui.service --no-pager -n 50

# Web UI 服务器日志（含 bridge 启动信息）
cat ~/.hermes-web-ui/server.log | tail -50

# Gateway 错误日志
cat ~/.hermes/logs/errors.log | tail -50

# 运行中的进程
ps aux | grep hermes | grep -v grep

# Bridge socket
ls -la /tmp/hermes-agent-bridge.sock

# 端口监听
ss -tlnp | grep -E '6060|8642'
```
