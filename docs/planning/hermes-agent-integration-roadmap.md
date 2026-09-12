# Hermes Agent Integration Roadmap (Web UI ↔ hermes-agent 0.21+)

Date: 2026-09-12
Status: Proposed — analysis against hermes-agent `0.21.2`
(`D:\code\hermes-agent-cn-mirror`); no changes applied.
Related: [hermes-agent-compat-0.21.md](hermes-agent-compat-0.21.md) — the
time-critical agent-bridge import fix. This document covers the slower,
architectural side of the same problem.

## Context

hermes-fleet currently integrates with Hermes Agent through three channels:

1. **Agent bridge** (chat): Node spawns the bundled Python broker, which
   imports `run_agent.AIAgent` and other Hermes internals directly; transport
   is newline-JSON over TCP/IPC with ~100ms output polling.
2. **Hermes CLI**: `execFile("hermes", …)` with regex parsing of
   human-readable stdout.
3. **Gateway management**: per-profile `hermes gateway run --replace` spawns.

Hermes Agent 0.21.2 now exposes **official integration surfaces** that make
most of the private coupling unnecessary:

- **TUI Gateway JSON-RPC** (`tui_gateway/server.py`, stdio or WebSocket) —
  sessions, prompt submit/steer, approvals/clarify, usage/titles, compression,
  MCP/env reload, config get/set, and **pushed events** (`message.delta`,
  `tool.start`, …) instead of polling.
- **ACP** (`hermes acp`, JSON-RPC over stdio) — session create/fork/resume,
  streaming, permission requests, paginated session list, usage updates.
- **OpenAI-compatible API server** (`gateway/platforms/api_server.py`, port
  8642) — `POST /v1/runs` lifecycle (run_id → events SSE / approval / steer /
  stop) and `GET /v1/capabilities` (machine-readable feature flags).
- **`hermes serve --port N`** — headless dashboard backend (FastAPI) with
  session/config/profile/MCP HTTP routes and an auth-provider system.
- **Gateway control socket** (`gateway/control_socket.py`, protocol version 1)
  — local `identify`/`status` probes; POSIX `$HERMES_HOME/gateway.sock`,
  Windows named pipe.
- **CLI `--json` flags** — `sessions`, `plugins`, `skills`, `config`,
  `approvals` and others support machine-readable output
  (`hermes_cli/subcommands/_shared.py`).

Upstream's stated policy (`COMPAT_MANIFEST.md`): internal import paths are
**not a stable API**. Anything below that reads agent stdout text or imports
agent internals is borrowed time.

## Priorities

### P1 — breakage already scheduled or in progress

1. **plugins.ts embedded Python** — imports `hermes_cli.plugins.PluginManager`
   privates (`_scan_directory`, `_get_disabled_plugins`, `_get_enabled_plugins`).
   On 0.21.2 the first two were split into `hermes_cli/plugins_discovery.py`
   and survive only via incidental re-import. Replace with
   `hermes plugins list --json` / catalog commands. (Also listed in the compat
   doc as a follow-up; tracked here for scheduling.)
2. **CLI stdout text parsing → `--json`** — five fragile call sites:
   - `hermes-cli.ts:504` logs list regex (only 4 known log names)
   - `hermes-cli.ts:625-645` `profile show` key/value text parsing
   - `profile-list-parser.ts:20,37-50` `◆` marker + English status words
   - `gateway-autostart.ts:316-327` "gateway is running" sentence matching
   - `hermes-cli.ts:220-232` sessions export NDJSON with silent skips

### P2 — replace bespoke probes with official ones

3. **Gateway health via control socket** — replace the combination of
   `gateway.pid` file reads, English-output matching, and Windows
   `netstat`/`taskkill` port cleanup (`manager.ts:375-417`) with the
   `identify`/`status` control-socket protocol.
4. **Capability probing via `GET /v1/capabilities` or `hermes --version`** —
   the write-gate's support-file sniffing (`write-gate.ts:341-397`) breaks
   whenever the support file layout changes.
5. **Custom provider config → new schema** — write path still emits the old
   `custom_providers:` list (`custom-providers-compat.ts:201-231`); upstream
   config now documents `model.providers:` named entries with `key_env` /
   `key_cmd`. Switch writes before the next upstream migration.

### P3 — strategic: migrate the agent bridge off private imports

6. Evaluate **TUI Gateway JSON-RPC** as the bridge transport. Its method
   surface maps almost 1:1 onto the current bridge actions
   (`session.create/history/usage/title/compress`, `prompt.submit/background`,
   `session.steer`, `approval.respond`, `clarify.respond`, `reload.mcp`,
   `config.set/get`) and adds event push, eliminating the 100ms
   `get_output` polling loop (`client.ts:504-552`). ACP is the fallback
   candidate; `hermes serve` is worth evaluating for the management plane
   (profiles/config/MCP) separately from chat.
7. Once 6 lands, the entire `agent-bridge/python/` private-import surface
   (and `hermes_compat.py` from the compat fix) becomes deletable.

### P4 — hygiene

8. Close the pending TODOs once the above lands: old-endpoint recovery gate
   (`manager.ts:83-88,765-772`, waiting on endpoint scoping), the three
   "test provider without gateway restart" TODOs (`controllers/hermes/providers.ts:187,228,301`)
   — upstream `reload.mcp` / `reload.env` may already make these feasible.
9. Sync the exclusive-platform list (`profile-credentials.ts:52-68`) against
   current `gateway/platforms/` (QQ and 飞书 were added upstream recently).
10. Derive reserved profile names (`gateway-autostart.ts:32-41`) from
    `hermes --help` instead of a hardcoded list; collapse the agent-root
    hardcoded probe lists (`manager.ts:229-232`, `bridge_runtime.py:287-295`)
    into explicit `HERMES_AGENT_ROOT` configuration plus documented layout.

## Suggested sequencing

The compat fix (sibling doc) lands first and unblocks 0.21.x. Items 1-2 (P1)
ride the same or an immediately following release. Items 3-5 are independent
and can be picked up in any order. Item 6 is a design spike (protocol parity
check against the bridge's action set + approval/clarify flows) before any
code moves.
