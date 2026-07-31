# ssh-mcp-toolkit

> A Model Context Protocol (MCP) server that gives LLM clients safe, persistent SSH access to remote machines — with multi-hop ProxyJump tunneling, SFTP file transfer, local port forwarding, and internet egress for internal servers.

---

## Table of Contents

1. [Overview](#overview)
2. [New Features（新增功能一览）](#new-features新增功能一览)
3. [Key Features](#key-features)
4. [Architecture](#architecture)
5. [Installation](#installation)
6. [Running the Server](#running-the-server)
7. [Client Integrations](#client-integrations)
   - [Claude Desktop](#claude-desktop)
   - [Claude Code](#claude-code)
   - [Codex](#codex)
   - [Cursor](#cursor)
8. [Host Configuration](#host-configuration)
   - [Host Storage](#host-storage)
   - [Adding Hosts](#adding-hosts)
   - [Listing Hosts](#listing-hosts)
   - [Editing Hosts](#editing-hosts)
   - [Removing Hosts](#removing-hosts)
9. [Session Management](#session-management)
   - [Starting a Session](#starting-a-session)
   - [Listing Sessions](#listing-sessions)
   - [Executing Commands](#executing-commands)
   - [Closing Sessions](#closing-sessions)
10. [File Transfer](#file-transfer)
11. [Internet Egress](#internet-egress)
12. [Port Forwarding (Tunnels)](#port-forwarding-tunnels)
13. [Authentication Modes](#authentication-modes)
14. [Timeouts & Inactivity Handling](#timeouts--inactivity-handling)
15. [Directory Structure](#directory-structure)
16. [Using the MCP Tools](#using-the-mcp-tools)
17. [Testing](#testing)
18. [Troubleshooting](#troubleshooting)
19. [Security Considerations](#security-considerations)
20. [Contributing](#contributing)
21. [Credits & Acknowledgements（致谢）](#credits--acknowledgements致谢)
22. [License](#license)

---

## Overview

`ssh-mcp-toolkit` lets MCP-compatible clients (such as Claude Code, Cursor, or custom MCP inspectors) control remote machines through SSH. Once hosts are registered, the server maintains persistent shell sessions that retain environment state between commands—ideal for multi-step workflows, long-running processes, or interactive diagnostics. Hosts that are not directly reachable can be tunneled through any number of jump hosts, and files can be moved in either direction over SFTP across the same tunnel.

The server is implemented in TypeScript on top of the official [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

Hosts that are not directly reachable can be tunneled through any number of jump hosts. The same chain also powers local port forwarding: an internal service's port can be exposed to the local machine over a dedicated SSH tunnel, so ordinary tools (browsers, database clients, admin consoles) can reach it at `http://localhost:PORT`.

---

## New Features（新增功能一览）

本项目是 [`ssh-mcp-sessions@1.0.17`](#credits--acknowledgements致谢) 的二次开发。以下能力均为本项目在既有 SSH 会话 / SFTP 基础之上新增：

| 能力 | 相关工具 / 字段 | 说明 | 详见 |
|---|---|---|---|
| 多跳跳板 ProxyJump | `add-host` 的 `proxyJump` 字段 | 任意跳数的链式 SSH 穿透；纯 JS 实现（ssh2 `forwardOut`），**无需本地 `ssh` 命令** | [Host Configuration](#host-configuration)、[File Transfer](#file-transfer) |
| SFTP 文件传输 | `upload-file` / `download-file` | 复用同一条跳板链上传/下载文件，自动创建远端缺失的父目录 | [File Transfer](#file-transfer) |
| 本地端口转发（隧道） | `open-tunnel` / `close-tunnel` / `list-tunnels` | 把内网应用端口暴露到本机 `localhost`（`ssh -L` 风格），支持多跳，2 小时无活跃连接自动回收 | [Port Forwarding (Tunnels)](#port-forwarding-tunnels) |
| 内网出网（Internet Egress） | `open-egress` / `close-egress` / `list-egress` | 让内网服务器 B/C 经本地机器访问外网（`ssh -R` + 本地 HTTP 正向代理），可用于 `apt`/`pip`/`npm` 下包 | [Internet Egress](#internet-egress) |

所有新增均向后兼容：原有 `hosts.json` 格式与既有工具调用方式完全不变。

---

## Key Features

- **MCP-compliant:** exposes functionality through standard MCP tool definitions.
- **Persistent sessions:** keep shell sessions alive, preserving working directory, environment variables, and process state across multiple commands.
- **Stored host profiles:** manage SSH targets through durable JSON configuration (`~/.ssh-mcp/hosts.json`).
- **Flexible authentication:** supports passwords, private keys, and SSH agent forwarding (fallback).
- **SFTP file transfer:** upload and download files directly, including targets reached through a configured jump host.
- **Local port forwarding:** expose an internal service's port to the local machine over the same SSH chain — including multi-hop setups — with no local `ssh` binary required.
- **Internet egress:** let internal servers without direct internet access download packages through the local machine via an HTTP proxy on the jump host (`open-egress`).
- **Timeout & cleanup safeguards:** sessions and tunnels auto-close after prolonged inactivity; commands are marked and monitored for completion.
- **Structured listings:** query active sessions and saved hosts directly from the MCP client.

---

## Architecture

```
MCP Client ─┬─> add-host / edit-host / remove-host
            │
            ├─> list-hosts
            │
            ├─> start-session ─┬─> PersistentSession (ssh2 shell)
            │                  ├─> exec (reuses shell, captures stdout/stderr)
            │                  └─> close-session / auto-timeout
            │
            ├─> upload-file / download-file ─> temporary SFTP connection
            │                                └─> optional ProxyJump tunnel
            │
            ├─> open-tunnel ──> PortForward (net.Server + conn.forwardOut)
            │    close-tunnel / list-tunnels  └─> dedicated SSH connection
            │                                   └─> optional ProxyJump tunnel
            │
            ├─> open-egress ──> InternetEgress (forwardIn on A + inline HTTP proxy)
            │    close-egress / list-egress  └─> local machine is the egress
            │
            └─> list-sessions

Persistent configuration → ~/.ssh-mcp/hosts.json
```

Each active session maintains:
- SSH connection via [`ssh2`](https://www.npmjs.com/package/ssh2)
- Interactive shell (`conn.shell`) to support multi-command pipelines
- Buffered output with unique UUID markers to detect command completion
- Inactivity timer (defaults to 2 hours)

---

## Installation

> This fork is **not published to npm** — the `ssh-mcp-sessions` package name belongs to the upstream project. Install it directly from GitHub, which gives you the `ssh-mcp-toolkit` executable.

### Global install from GitHub (preferred)

```bash
npm install -g github:xunuo2345/ssh-mcp-toolkit
```

The `prepare` script compiles TypeScript during install. Launch the server anywhere by running `ssh-mcp-toolkit`.

### From source

```bash
git clone https://github.com/xunuo2345/ssh-mcp-toolkit.git
cd ssh-mcp-toolkit
npm install          # `prepare` runs the build for you
```

The entry point is then `build/index.js`; run it with `node /absolute/path/to/build/index.js`.

---

### Claude Desktop

Add an entry to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the appropriate config path on Windows/Linux:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "ssh-mcp-toolkit"
    }
  }
}
```

Restart Claude Desktop after saving the file. You can now use the MCP Inspector or the command palette (`Cmd/Ctrl+Shift+O`) to call tools like `add-host` and `start-session`.

### Claude Code (VS Code extension)

Update the Claude Code workspace settings (`.vscode/settings.json` or global settings) with:

```json
{
  "claude.mcpServers": {
    "ssh-mcp": {
      "command": "ssh-mcp-toolkit"
    }
  }
}
```

Reload the window. The MCP panel will list `ssh-mcp`, and commands are available via the command palette (`Ctrl/Cmd+Shift+P` → “Claude: Run MCP Tool”).

### Codex (OpenAI GPT-4o/5 with MCP)

Create or edit `~/.config/openai-codex/mcp.toml` (the path may differ per platform—use the location documented by the client). Add:

```toml
[mcpServers."ssh-mcp"]
command = "ssh-mcp-toolkit"
```

Restart Codex or re-open the MCP inspector. The `ssh-mcp` tools will appear under the configured servers list.

### Cursor IDE

Open Cursor settings → “Model Context Protocol” (or edit `~/Library/Application Support/Cursor/mcp.json` directly) and include:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "ssh-mcp-toolkit"
    }
  }
}
```

After saving, reload Cursor. The MCP sidebar exposes the server; you can invoke tools via chat or the command palette (`Cmd/Ctrl+Shift+L`).

> **Tip:** If the executable is not on your `PATH` (e.g. you installed from source rather than globally), point the client at the built file instead:
> `{ "command": "node", "args": ["/absolute/path/to/ssh-mcp-toolkit/build/index.js"] }`

---

## Running the Server

```bash
ssh-mcp-toolkit
```

The server is purely stdio-based. Once running it prints:

```
SSH MCP Server running on stdio
```

You can register it with Claude Code or any other MCP client by pointing to the installed executable:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "ssh-mcp-toolkit"
    }
  }
}
```

If it is not on your `PATH`, use `{ "command": "node", "args": ["/absolute/path/to/build/index.js"] }` instead.

> **Note:** The server no longer accepts CLI arguments for host/user/password. Everything is configured dynamically via MCP tools.

---

## Host Configuration

### Host Storage

- Hosts are persisted in `~/.ssh-mcp/hosts.json`.
- The directory is created automatically if it does not exist.
- File format:

```json
{
  "hosts": [
    {
      "id": "host",
      "host": "host.local",
      "port": 22,
      "username": "user",
      "password": "...",     // optional
      "keyPath": "~/.ssh/id_rsa" // optional
    }
  ]
}
```

Fields:
- `id` (string) — unique identifier used by all session commands.
- `host` (string) — hostname or IP.
- `port` (number, default 22) — SSH port.
- `username` (string) — SSH user.
- `password` (optional string) — password auth.
- `keyPath` (optional string) — private key path; tilde expansion supported.
    - If neither `password` nor `keyPath` is provided, the server attempts to use the local SSH agent via `SSH_AUTH_SOCK` (with agent forwarding enabled).

> The MCP tools ensure this file remains well-formed; never edit it manually unless you know what you’re doing.

### Adding Hosts

Tool: **`add-host`**

```json
{
  "host_id": "user@host.local",
  "host": "host.local",
  "port": 22,
  "username": "user",
  "password": "optional",
  "keyPath": "optional"
}
```

- `host_id`: new identifier. Must be unique.
- `host`: hostname or IP.
- `port`: optional (defaults to 22); provide integer > 0.
- `username`: SSH user.
- `password` or `keyPath`: optional; configure one or rely on agent.

Example (Claude Code command palette or inspector):

```
/mcp mcp-remote-ssh add-host {"host_id":"host","host":"host.local","username":"user"}
```

### Listing Hosts

Tool: **`list-hosts`**

Returns text with one host per line:

```
id=host host=host.local:22 user=user auth=agent
```

`auth` values:
- `password` — password field present
- `key` — keyPath present
- `agent` — neither password nor keyPath; agent fallback active

### Editing Hosts

Tool: **`edit-host`**

```json
{
  "host_id": "user@host.local",
  "port": 2222,
  "password": "new-pass"
}
```

Only supply the properties you want to change. Omitted fields remain unchanged; providing `null` to a field is not supported—set an empty string or remove the host instead.

### Removing Hosts

Tool: **`remove-host`**

```json
{
  "host_id": "user@host.local"
}
```

Deletes the entry from `hosts.json`. Active sessions using that host must be closed manually.

---

## Session Management

### Starting a Session

Tool: **`start-session`**

```json
{
  "host_id": "user@host.local"
}
```

Optionally you can supply `sessionId`; otherwise, a UUID is returned.

Example response:

```fff4b34b-56dd-4711-9555-c04e8b64249b
```

### Listing Sessions

Tool: **`list-sessions`**

Shows all active sessions with metadata:

```
session=fff4… host=host.local:22 user=user uptime=3m12s lastCommand=ls -la
```

### Executing Commands

Tool: **`exec`**

```json
{
  "session_id": "fff4b34b-56dd-4711-9555-c04e8b64249b",
  "command": "pwd"
}
```

- Commands are sanitized (trimmed, length-limited).
- Output is captured from the persistent shell and returned as plain text.
- Non-zero exit codes raise `McpError` with stderr in the message.

Example output:

```
/home/user
```

### Closing Sessions

Tool: **`close-session`**

```json
{
  "sessionId": "fff4b34b-56dd-4711-9555-c04e8b64249b"
}
```

> Note: session IDs for `close-session` use `sessionId` (camelCase) to remain backwards compatible with the underlying tool definition.

### Legacy Helper

Function `execSshCommand(hostId, command, sessionId?)` remains exported for programmatic use and simply delegates through the session machinery described above.

---

## File Transfer

File transfers use SFTP and do not need a persistent shell session. When the selected target host has `proxyJump` configured, the SFTP connection is tunnelled through that jump host. This supports the topology where the MCP machine can reach A, and A can reach internal hosts. Intermediate hosts only forward encrypted SSH traffic: no file or directory is created on them.

### Multiple jump hosts

`proxyJump` can form a chain by referencing another configured host. For example, configure the locally reachable gateway first, then make each deeper host point to the immediately preceding hop:

```text
MCP machine -> gateway -> A -> B

gateway: no proxyJump
A:       proxyJump = "gateway"
B:       proxyJump = "A"
```

Use `host_id: "B"` with `upload-file` or `download-file`. The service creates a nested SSH forwarding channel for every hop, and the SFTP operation still runs only on B. Circular jump configurations are rejected.

### Upload a file

Tool: **`upload-file`**

```json
{
  "host_id": "internal-host",
  "local_path": "C:/artifacts/app.tar.gz",
  "remote_path": "/opt/releases/app.tar.gz"
}
```

The source must be a local regular file. Missing remote parent directories are created recursively. An existing remote file at `remote_path` is replaced.

### Download a file

Tool: **`download-file`**

```json
{
  "host_id": "internal-host",
  "remote_path": "/var/log/app.log",
  "local_path": "C:/downloads/app.log"
}
```

The local destination directory must already exist. An existing local file at `local_path` is replaced.

---

## Port Forwarding (Tunnels)

The server can expose a port of an internal service to the local machine over a dedicated SSH tunnel — the same style as `ssh -L` local port forwarding, implemented entirely in JavaScript on top of ssh2. The tunnel reuses the host's `proxyJump` chain, so multi-hop topologies work with no extra configuration, no local `ssh` binary, and no inbound firewall changes on the target network.

Typical scenario: the local machine can only reach an internal gateway over SSH, and an application (web service, database, admin console, …) runs on a machine further inside. After opening a tunnel, the service is reachable at `http://localhost:PORT` on the local machine.

### Opening a tunnel

Tool: **`open-tunnel`**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `host_id` | string | ✔ | — | Registered host whose SSH chain (including its `proxyJump`) forwards to the service |
| `remote_port` | number | ✔ | — | Service port, 1–65535 |
| `remote_host` | string | | `127.0.0.1` | Service address as reachable from the chain's final hop |
| `local_port` | number | | auto-assigned | Local port to listen on |
| `local_bind` | string | | `127.0.0.1` | Local address to bind; non-loopback binds log a warning |
| `tunnel_id` | string | | auto UUID | Identifier used by `close-tunnel` / `list-tunnels` |

```json
{
  "host_id": "internal-gateway",
  "remote_host": "127.0.0.1",
  "remote_port": 8080,
  "local_port": 8080,
  "tunnel_id": "web"
}
```

Response:

```
Tunnel 'web' listening on 127.0.0.1:8080 -> 127.0.0.1:8080
```

After this, `http://localhost:8080` on the MCP machine reaches the internal service. With a multi-hop chain the response shows the full path, e.g.:

```
Tunnel 'web' listening on 127.0.0.1:8080 -> gateway -> app-server -> 127.0.0.1:8080
```

### Listing tunnels

Tool: **`list-tunnels`**

```
tunnel=web local=127.0.0.1:8080 -> host=app-server remote=127.0.0.1:8080 jump=gateway -> app-server state=active conns=0/1 idle=0s
```

- `jump=` shows the full jump path, or `direct` when the host has no `proxyJump`.
- `conns=active/total` counts live vs. cumulative connections through the tunnel.
- `idle=` is shown while no connection is active.
- `state=dead` (with `lastError=`) marks a tunnel whose SSH chain dropped; the record is kept until you close it.

### Closing a tunnel

Tool: **`close-tunnel`**

```json
{
  "tunnel_id": "web"
}
```

Closes the local listener, destroys all active connections, and tears down the SSH chain (including every jump hop).

### Lifecycle

- Tunnels are independent of shell sessions — opening one does not require `start-session`.
- A tunnel auto-closes after **2 hours of inactivity** (the same timeout as sessions); any active connection keeps it alive.
- Closing the MCP server process closes all tunnels.
- If the SSH chain drops (network interruption, host restart), the tunnel transitions to `dead`; a failed individual connection does not close the tunnel.

---

## Internet Egress

Let internal servers that cannot reach the internet (B, C, …) download packages through the local machine. The server asks host A to listen on a port (remote port forwarding, `ssh -R` style); every connection to that port is forwarded back over the SSH tunnel to the local machine, which acts as an HTTP forward proxy (`CONNECT` for HTTPS, plain forwarding for HTTP).

Only the outbound SSH connection from the local machine to A is required — no inbound firewall changes on the internal network.

### A-side prerequisites

The SSH server on A must allow TCP forwarding, and a non-loopback bind requires `GatewayPorts`:

```ini
# /etc/ssh/sshd_config (on the linuxserver docker image: /config/sshd/sshd_config)
AllowTcpForwarding yes
GatewayPorts clientspecified
```

`GatewayPorts clientspecified` lets the client supply the bind address (the behavior `open-egress` needs); plain `yes` also works but forces binding to all interfaces.

### Opening an egress

Tool: **`open-egress`**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `host_id` | string | ✔ | — | Host (A) on which to open the proxy port |
| `proxy_port` | number | ✔ | — | Port to listen on A, 1–65535 |
| `proxy_bind` | string | ✔ | — | Specific interface IP on A to bind (reachable by the machines that will use the proxy); wildcards like `0.0.0.0` are rejected |
| `egress_id` | string | | auto UUID | Identifier used by `close-egress` / `list-egress` |

```json
{
  "host_id": "A",
  "proxy_bind": "192.168.1.10",
  "proxy_port": 8080,
  "egress_id": "apt-mirror"
}
```

Response:

```
Egress 'apt-mirror' on A:192.168.1.10:8080 -> local internet egress
```

### Using it from B/C

On any machine that can reach `A`, point your package manager at the proxy:

```bash
export http_proxy=http://192.168.1.10:8080
export https_proxy=http://192.168.1.10:8080
apt update        # or: yum/dnf/apk/pip/npm/go …
```

### Listing / closing

Tool: **`list-egress`** shows one line per egress (bind address, state, connection counts, idle time, or `lastError` when dead). Tool: **`close-egress`** with `egress_id` removes the listener on A and tears down the connection.

### Lifecycle

- An egress auto-closes after **2 hours of inactivity** (same timeout as sessions/tunnels), counted only while no connection is active.
- If the SSH chain drops, the egress becomes `dead` and stays visible in `list-egress` until closed.
- There is **no proxy authentication** — the port is open to the host's network; bind `proxy_bind` to a specific IP to limit exposure.

---

## Authentication Modes

1. **Password** — stored in `hosts.json`; transmitted to `ssh2` during connection.
2. **Private key** — `keyPath` read at runtime; supports encrypted keys (prompt user to set `SSH_MCP_KEY_PASSPHRASE` before launch if needed).
3. **SSH agent (fallback)** — if neither password nor key is set and `SSH_AUTH_SOCK` is present, the agent is passed to `ssh2` (`agentForward: true`).

---

## Timeouts & Inactivity Handling

- Each session has a **global inactivity timeout** (default 2 hours). Timer resets whenever a command executes successfully.
- If the timer elapses, the session cleans up the SSH connection, shell, and resolver buffer, and removes itself from `activeSessions`.
- Command completion uses a UUID marker: `printf '__MCP_DONE__{uuid}%d\n' $?`. Output before the marker is returned; numeric code after the marker becomes the exit status.
- Each tunnel shares the same **2-hour inactivity timeout**, but only counts while **no connection** is flowing through it. The timer is cleared as soon as a connection opens and restarts after the last one closes. Internet egress tunnels behave the same way.

---

## Directory Structure

```
ssh-mcp-toolkit/
├── build/                # Compiled JS output (npm run build)
├── src/index.ts          # Primary MCP server implementation
├── test/                 # Vitest tests (CLI-only; integration tests skipped)
├── package.json
├── README.md             # This document
└── ~/.ssh-mcp/hosts.json # Created at runtime (per user)
```

---

## Using the MCP Tools

Below is a typical workflow using Claude Code (commands start with `/mcp`), but the same JSON payloads apply to any MCP inspector.

1. **Add host**
   ```
   /mcp mcp-remote-ssh add-host {"host_id":"host","host":"host.local","username":"user"}
   ```

2. **Start session**
   ```
   /mcp mcp-remote-ssh start-session {"host_id":"host"}
   ```
   → returns `session_id`

3. **Run commands**
   ```
   /mcp mcp-remote-ssh exec {"session_id":"<id>","command":"pwd"}
   /mcp mcp-remote-ssh exec {"session_id":"<id>","command":"ls -la"}
   ```

4. **Transfer files (optional)**
   ```
   /mcp mcp-remote-ssh upload-file {"host_id":"host","local_path":"C:/build/app.tar.gz","remote_path":"/tmp/app.tar.gz"}
   /mcp mcp-remote-ssh download-file {"host_id":"host","remote_path":"/var/log/app.log","local_path":"C:/downloads/app.log"}
   ```

5. **Expose an internal service (optional)**
   ```
   /mcp mcp-remote-ssh open-tunnel {"host_id":"host","remote_port":8080,"local_port":8080}
   ```
   → returns a tunnel id; the service is then reachable at `http://localhost:8080`. Close it with `close-tunnel`.

6. **Provide internet access to internal machines (optional)**
   ```
   /mcp mcp-remote-ssh open-egress {"host_id":"A","proxy_bind":"192.168.1.10","proxy_port":8080}
   ```
   → returns an egress id; machines that can reach A can then use `http://192.168.1.10:8080` as their HTTP proxy. Close it with `close-egress`.

7. **Inspect**
   ```
   /mcp mcp-remote-ssh list-sessions
   /mcp mcp-remote-ssh list-hosts
   /mcp mcp-remote-ssh list-tunnels
   ```

8. **Close session / tunnel**
   ```
   /mcp mcp-remote-ssh close-session {"sessionId":"<id>"}
   /mcp mcp-remote-ssh close-tunnel {"tunnel_id":"<id>"}
   /mcp mcp-remote-ssh close-egress {"egress_id":"<id>"}
   ```

---

## Testing

Unit tests (Vitest):

```bash
npm run test
```

Integration smoke tests for SSH are not included by default because they require external infrastructure. You can manually validate with the workflow above.

---

## Troubleshooting

| Symptom | Possible Cause | Suggested Action |
|---------|----------------|------------------|
| `Host 'xyz' already exists` | Duplicate `host_id` | Use `edit-host` or pick a new ID. |
| `Host 'xyz' not found` | Missing entry | Run `list-hosts` to confirm; add host again if needed. |
| `Error (code X): …` | Remote command returned non-zero | Inspect the command output. The session remains open. |
| Session disappears from `list-sessions` | Inactivity timeout reached | Start a new session or reduce idle periods. |
| Permission denied (publickey) | Missing credentials | Ensure `keyPath` or agent has the right key. |
| `Invalid key path` | `keyPath` resolved to undefined or missing file | Provide an absolute/tilde path that exists. |
| `Local port X is already in use` | The requested `local_port` is taken | Pick another port, or omit `local_port` to auto-assign. |
| Tunnel shows `state=dead` | SSH chain dropped (network, restart) | Read `lastError` in `list-tunnels`, then `close-tunnel` and reopen. |
| `Failed to listen on ... on host` | sshd on A denies remote forwarding | Set `AllowTcpForwarding yes` (and `GatewayPorts yes` for non-loopback binds) on A, then retry. |

---

## Security Considerations

- Treat `~/.ssh-mcp/hosts.json` as sensitive; it may contain passwords or key paths.
- Prefer key-based or agent authentication where possible.
- Limit `hosts.json` permissions: `chmod 600 ~/.ssh-mcp/hosts.json`.
- Sessions inherit all privileges of the configured SSH user.
- Long-running sessions can be closed manually or rely on the inactivity timeout.

---

## Contributing

1. Fork the repo and create a branch.
2. Make your changes with tests and documentation updates.
3. Run `npm run build` and `npm run test` before submitting a PR.
4. Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

Issues and feature requests are welcome via GitHub.

---

## Credits & Acknowledgements（致谢）

本项目是**基于开源项目的二次开发**，没有前人的工作就没有它。在此向原作者致以诚挚的谢意：

- **[`ssh-mcp-sessions`](https://github.com/fryjustinc/ssh-mcp-sessions) — 作者 Justin Fry（[@fryjustinc](https://github.com/fryjustinc)）**
  本仓库的直接上游，分叉自 npm [`ssh-mcp-sessions@1.0.17`](https://www.npmjs.com/package/ssh-mcp-sessions)（MIT）。`~/.ssh-mcp/hosts.json` 主机档案存储、带 `__MCP_DONE__` 完成标记的常驻 shell 会话模型、密码 → 私钥 → SSH agent 的认证回退链，以及最初的 8 个 MCP 工具，全部是他的工作成果。**衷心感谢。**

- **[`ssh-mcp`](https://github.com/tufantunc/ssh-mcp) — 作者 Tufan Tunç（[@tufantunc](https://github.com/tufantunc)）**
  更早的 SSH-over-MCP 项目，也是整条血脉的起点（`exec` 工具即源于此）。上游 `ssh-mcp-sessions` 于 2025-09-29 从该项目分叉（两个仓库共有 28 个相同的提交历史），本项目代码中 `McpServer` 至今仍标着的版本号 `1.0.9`，正是当年分叉时它的版本。**感谢他打下的地基。**

两个上游项目均为 MIT 许可；本 fork 继续沿用 MIT，并在 [LICENSE](./LICENSE) 中保留原始版权声明。

### 本项目在上游 1.0.17 之上新增的能力

- **ProxyJump 跳板机支持** —— 主机配置新增可选的 `proxyJump` 字段，支持任意跳数的链式穿透；完全用 JavaScript 通过 ssh2 的 `forwardOut` 实现，**无需本地 `ssh` 命令**，在 Windows 和 Linux 上行为一致。保存配置时会拒绝自引用、不存在的跳板机以及成环配置。
- **SFTP 文件传输** —— 新增 `upload-file` 与 `download-file` 两个工具，复用同一条跳板链，自动创建远端缺失的父目录，且**不在中间跳板机上留下任何文件**。
- **跳板信息可见** —— `list-hosts` 输出附带 `jump=<id>`，`list-sessions` 展示完整跳板路径（`jump=gateway -> a -> b`）或 `direct`。
- **本地端口转发（隧道）** —— 新增 `open-tunnel` / `close-tunnel` / `list-tunnels` 三个工具，把内网服务的端口通过专用 SSH 隧道暴露到本机回环地址（`ssh -L` 风格，纯 JavaScript 实现）。完全复用同一套多跳跳板链，无需本地 `ssh` 命令；每条隧道 2 小时无活跃连接自动回收，SSH 链路断开时标记为 `dead` 供 `list-tunnels` 查看。
- **内网出网（Internet Egress）** —— 新增 `open-egress` / `close-egress` / `list-egress` 三个工具：在跳板机 A 上反向监听端口（`ssh -R` 风格），把内网 B/C 的 HTTP 代理流量经 SSH 隧道送回本地，由本地作为出口代理访问外网。无需内网开放任何入站端口，纯 JavaScript 实现。
- **单元测试** —— 覆盖主机 schema、跳板链解析与跳板配置校验。

以上新增均向后兼容：原有的 `hosts.json` 与原有的工具调用方式行为完全不变。

---

## License

[MIT](./LICENSE)

---

**Happy automating!** If this project improves your workflow, please star the repository or share feedback. Your contributions help make remote development safer and simpler for everyone. 
