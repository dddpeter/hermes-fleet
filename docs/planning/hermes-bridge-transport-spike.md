# Bridge Transport Migration — Design Spike

Date: 2026-09-12
Status: Analysis complete — no code moved. Decides Workstream D of
[hermes-agent-integration-execution.md](hermes-agent-integration-execution.md).

## Question

Can the self-built agent bridge
(`packages/server/src/services/hermes/agent-bridge/`, newline-JSON over
TCP/IPC, ~60 private-symbol patch tuples, 100ms output polling) be replaced
by an official Hermes Agent protocol, so upstream refactors stop breaking the
Web UI?

Method names below were extracted from the 0.21.2 mirror
(`tui_gateway/methods_*.py`, registered via `@method(...)` into
`tui_gateway/server.py`), not from docs.

## Candidate: TUI Gateway JSON-RPC (`hermes --tui` backend, stdio or WebSocket)

`hermes-fleet`'s bridge spawns one Python worker per profile (each with its
own `HERMES_HOME`). The TUI gateway is likewise per-home, so the existing
per-profile orchestration maps onto N gateway processes with the transport
swapped from custom socket to stdio/WebSocket JSON-RPC.

### Action parity (AgentBridgeClient → TUI Gateway method)

| Bridge action | TUI Gateway method | Notes |
| --- | --- | --- |
| `chat` | `prompt.submit` / `prompt.background` | streaming replaces polling |
| `get_output` (100ms poll) | pushed events `message.delta`/`message.complete`/`tool.start`/`tool.progress`/`tool.complete`, plus cursor-based `session.events.since` | biggest single win |
| `get_result` | `session.status` + completion event | |
| `interrupt` | `session.interrupt` | |
| `steer` | steering authority exists (`_current_session_steer_authority`); exact method to verify (likely `prompt.submit` on a live session) | spike follow-up |
| `approval_respond` | `approval.respond` (+ `approval.pending`/`approval.received` events) | |
| `clarify_respond` | `clarify.respond` | |
| `compression_respond` | approval flow around `session.compress` | verify payload shape |
| `goal_evaluate` / `goal_pause` | `command.dispatch` (`/goal`) + `delegation.pause`/`delegation.status` | |
| `switch_session_model` | model switch path (`tui_gateway/model_switch.py`, `model.save_key`, `config.set`) | verify per-session semantics |
| `context_estimate` | `session.context_breakdown` | |
| `get_session_title` | `session.title` | |
| `get_history` | `session.history` | |
| `status` | `session.status` | |
| `destroy` / `destroy_all` / `destroy_profile` | `session.close` / `session.delete` | per-session; no batch verb |
| `mcp_list` / `mcp_tools_list` | `config.get` (mcp_servers) + `session.context_breakdown`-style inventories | verify |
| `mcp_server_add`/`update`/`remove` | `config.set` (mcp_servers) — Web UI already writes config.yaml itself | unchanged |
| `mcp_server_test` | `mcp.servers.test` | exists (long handler) |
| `mcp_reload` | `reload.mcp` | exists |
| `skills_reload` | `skills.manage` | verify reload verb |
| `command` | `command.dispatch` / `slash.exec` | |
| `ping` | transport-level; `gateway.capabilities` for health+features | capability probe for C2 |

### Gaps / risks

1. **Multi-session fan-out.** The bridge multiplexes many Web UI sessions per
   worker; the TUI gateway supports multiple sessions per process, but the
   Desktop/TUI clients use one active session. `session.active_list` +
   multi-client fan-out tests (`tests/tui_gateway/test_multi_client_fanout.py`)
   suggest it is supported — verify concurrent `prompt.submit` across N
   sessions.
2. **Worker lifecycle.** The bridge owns worker spawn/respawn/destroy per
   profile (`AgentBridgeManager`). The gateway equivalent is spawning
   `hermes --tui --...`/WS server per profile and detecting death — needs a
   supervisor story (or reuse `ws.py` server mode).
3. **Protocol stability.** The TUI gateway is the Ink TUI's backend — a UI
   contract, not a declared stable API, though far more public than private
   imports. ACP (also official) is the declared stable alternative if TUI
   churn is a concern.
4. **Group chat.** `group-chat/` runs multi-agent conversations over the
   bridge; must be re-validated against gateway session semantics.

### Recommendation

Proceed in three steps:

1. **Feature-freeze compat tracking first (done):** `hermes_compat.py` +
   resolution logging keep the current bridge working; no urgency pressure.
2. **Pilot:** run a TUI gateway per profile in parallel with the bridge behind
   an env flag (`HERMES_WEB_UI_TRANSPORT=tui-gateway|bridge`), implement
   `chat`/`interrupt`/`approval`/events only, and compare behavior in dev.
3. **Cut over per action** once the pilot holds: events replace `get_output`
   polling first (isolated, highest value), then session management, then
   MCP/skills verbs; delete the Python bridge last.

ACP (`hermes acp`, stdio JSON-RPC, agent-client-protocol 0.9.0) is the
fallback candidate; it covers session lifecycle + streaming + approvals but
lacks the MCP/skills/goal verbs the bridge exposes, so TUI Gateway is the
primary target.
