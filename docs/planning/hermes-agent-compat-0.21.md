# Hermes Agent 0.21 Compatibility Audit (agent-bridge)

Date: 2026-09-12 (re-verified symbol-by-symbol against the 0.21.2 mirror on this date)
Status: **Implemented 2026-09-12** — `hermes_compat.py` wired into all five
call sites; `tests/server/agent-bridge-compat-resolution.test.ts` added
(resolution trees + raw-import regression guard); README updated. Remaining:
optional worker-start version logging (fix-plan step 5). Full-suite run
matches the pre-change baseline (all failures are pre-existing
Windows-environment ones).
Reference tree: hermes-agent `0.21.2` (local mirror at `D:\code\hermes-agent-cn-mirror`).

> Re-verification note (2026-09-12): every claim below was re-checked against
> the 0.21.2 mirror. The `_run_on_mcp_loop` break is confirmed (absent from
> `tools/mcp_tool.py`, absent from its `PLUGIN-COMPAT` block at
> `tools/mcp_tool.py:664-719`, and absent from `compat_manifest.json`); the
> `set_current_session_key` / `reset_current_session_key` shim is confirmed at
> `tools/approval.py:1199-1202` (warns once via `hermes_cli/plugin_compat.py`
> `warn_once`, `HermesPluginCompatWarning` is a `FutureWarning`). An
> independent scan of all `tools.*` / `agent.*` / `hermes_cli.*` imports across
> the seven bridge Python files found no moved symbol beyond those listed
> here.

## Context

Hermes Agent's September 2026 decomposition split its large modules into
focused files. Internal import paths are explicitly **not a stable API**: the
old paths only keep working through temporary `PLUGIN-COMPAT` re-export
shims, which emit `HermesPluginCompatWarning` and are scheduled for removal
on **2026-09-14** (see `COMPAT_MANIFEST.md` in the hermes-agent repo). Private
names (leading `_`) were never covered by the shim layer at all.

The Web UI agent bridge (`packages/server/src/services/hermes/agent-bridge/python/`)
imports Hermes internals directly at run time. This audit resolved every such
import against the 0.21.2 source using an AST symbol scan plus the compat
manifest, and classifies each one below.

## Findings

### P0 — broken on hermes-agent 0.21.2 today

`tools.mcp_tool._run_on_mcp_loop` moved to `tools.mcp_tool_loop` and is **not**
in the compat map, so `from tools.mcp_tool import _run_on_mcp_loop` raises
`ImportError` on current hermes-agent. Both call sites swallow the error:

| Call site | Failure mode on 0.21.2 |
| --- | --- |
| `bridge_server.py` `_shutdown_all_mcp_servers` | returns `0`; managed MCP servers are never shut down |
| `bridge_server.py` `_handle_mcp_action` | every MCP management action (`mcp_server_add/update/remove/test`, `mcp_reload`, …) returns `{"error": "MCP tool module not available", "ok": false}` |

User-visible effect: MCP server management from the Web UI silently stops
working against hermes-agent 0.21.2.

Note: `_servers` and `_lock` are still owned by `tools.mcp_tool` in 0.21.2
(the new `mcp_tool_loop` / `mcp_tool_discovery` modules read them back through
`tools.mcp_tool` as "origin state"), so only `_run_on_mcp_loop` needs to move.

### P0 — deprecated now, hard break on 2026-09-14

`set_current_session_key` / `reset_current_session_key` moved from
`tools.approval` to `tools.approval_context`. The old path resolves through
the compat shim today (with a one-time `HermesPluginCompatWarning` per
process), and will raise `ImportError` once the shim layer is removed:

| Call site | Behavior |
| --- | --- |
| `bridge_pool.py` run start (~L1190) | `from tools.approval import register_gateway_notify, set_current_session_key` — one `try` block; on failure the approval session key is never set **and** `register_gateway_notify` is skipped, silently degrading gateway approval routing |
| `bridge_pool.py` run cleanup (~L1339) | `from tools.approval import reset_current_session_key, unregister_gateway_notify` inside `except Exception: pass` |

### P1 — compat-shim-only (works, warns, removed 2026-09-14)

| Symbol | New location | Call sites |
| --- | --- | --- |
| `discover_mcp_tools` | `tools.mcp_tool_discovery` | `bridge_runtime.py` `_discover_bridge_mcp_tools` (~L828), `bridge_server.py` `_handle_mcp_action` |
| `register_mcp_servers` | `tools.mcp_tool_discovery` | `bridge_server.py` `_handle_mcp_action` |

### P2 — fragile private imports (verified present in 0.21.2)

These still work but were never covered by any compatibility promise:

- `hermes_cli.tools_config._get_platform_tools` (`bridge_runtime.py` ~L805)
- `tools.mcp_tool._servers` / `tools.mcp_tool._lock` (`bridge_server.py`)

### Verified compatible (no action)

All remaining bridge imports resolve to real definitions at their existing
paths in 0.21.2: `run_agent.AIAgent`, `agent.runtime_cwd.set_session_cwd` /
`clear_session_cwd`, `tools.terminal_tool.register_task_env_overrides` /
`set_approval_callback`, `hermes_state.SessionDB`, `agent.moa_loop.MoAClient`,
`agent.model_metadata.estimate_request_tokens_rough`,
`tools.approval.register_gateway_notify` / `unregister_gateway_notify` /
`resolve_gateway_approval` / `load_permanent_allowlist` / `approve_permanent` /
`approve_session` / `save_permanent_allowlist`,
`hermes_constants.parse_reasoning_effort`, `agent.title_generator.maybe_auto_title`,
`agent.learn_prompt.build_learn_prompt`, `agent.skill_commands.reload_skills` /
`build_skill_invocation_message`, `agent.skill_bundles.build_bundle_invocation_message` /
`resolve_bundle_command_key`, `hermes_cli.config.load_config`,
`hermes_cli.goals.GoalManager`, `agent.prompt_builder`, `agent.auxiliary_client`,
`hermes_cli.runtime_provider.resolve_runtime_provider`,
`agent.skill_commands.resolve_skill_command_key` (`bridge_pool.py` ~L1518).

The facade's `_sync_*_patches` name tuples in `hermes_bridge.py` were also
checked: those names are the bridge's own module-internal symbols (copied
between the facade and its own runtime/pool/transport/server/broker modules),
not Hermes internals, so the decomposition does not affect them.

Server-side integration points are also compatible with 0.21.2:

- The gateway `api_server` default port is still `8642`, and upstream retired
  its old SHA-256 port allocator in favor of exactly the mechanism the Web UI
  already uses: per-profile `API_SERVER_PORT` env plus
  `platforms.<name>.extra.port` config (`gateway-runner.ts`).
- `hermes profile list` output (Profile/Model/Gateway/Alias/Distribution
  columns, `◆` active marker) matches the fixtures already covered by
  `tests/server/gateway-autostart.test.ts`.
- The `hermes gateway start/stop/status` CLI surface still exists
  (`hermes_cli/gateway.py`).

## Proposed Fix Plan

1. **Add `python/hermes_compat.py`** with a single resolver:

   ```python
   import_attr(new_module, name, old_module)
   ```

   It tries the current location first (no warning, no shim), falls back to
   the pre-decomposition location for older Hermes installs, and raises
   `ImportError` when the symbol exists in neither so call sites keep one
   `except ImportError` guard. A draft already exists in the working tree.

2. **Wire the five affected call sites** through `import_attr`:
   - `bridge_pool.py` run start / cleanup → `tools.approval_context` (fallback `tools.approval`)
   - `bridge_server.py` shutdown + action dispatch → `tools.mcp_tool_loop` (fallback `tools.mcp_tool`)
   - `bridge_runtime.py` + `bridge_server.py` discovery/registration → `tools.mcp_tool_discovery` (fallback `tools.mcp_tool`)

3. **Add a Python-stub Vitest** (pattern: `tests/server/agent-bridge-python-concurrency.test.ts`)
   covering three trees: new-location present → resolved from new module;
   only old location → falls back; neither → `ImportError`.
   Additionally add a cheap regression-guard test that scans
   `agent-bridge/python/*.py` for raw `from tools.mcp_tool import …` /
   `from tools.approval import …` lines touching the moved symbols, so new
   call sites cannot bypass `hermes_compat.py`.

4. **Document the fragility** in `agent-bridge/README.md`: internal import
   paths are not a stable API; new moved symbols must be added to
   `hermes_compat.py`, not re-scattered as try/except imports.

5. **Optional hardening:** log the resolved hermes-agent version (and any
   compat fallback taken) once per worker start, so a future upstream
   decomposition surfaces in worker logs instead of failing silently.

### Out of scope for this fix, same risk class (track separately)

`services/hermes/plugins.ts` embeds Python that imports
`hermes_cli.plugins.PluginManager` and calls the private
`_scan_directory` / `_get_disabled_plugins` / `_get_enabled_plugins`. On
0.21.2 those privates were split into `hermes_cli/plugins_discovery.py`
(`:80`, `:90`; `_scan_directory` remains a `PluginManager` method at
`hermes_cli/plugins.py:1417`) and survive only because `hermes_cli/plugins.py`
happens to re-import them (`plugins.py:44`) — private names are never covered
by the PLUGIN-COMPAT shims, so the next plugins refactor breaks Web UI plugin
enumeration silently. Follow-up: replace the embedded Python with the
official machine-readable surface (`hermes plugins list --json`, catalog
commands). Broader follow-ups (CLI `--json` migration, gateway control
socket, bridge transport migration off private imports) are tracked in
[hermes-agent-integration-roadmap.md](hermes-agent-integration-roadmap.md).

## Verification Plan

- `npx vitest run tests/server/agent-bridge-compat-resolution.test.ts` (new)
- `npx vitest run tests/server/agent-bridge-python-concurrency.test.ts`
  (existing stub harness must still pass)
- Real-tree smoke: launch the bridge worker with the mirror on `PYTHONPATH`
  and assert no `HermesPluginCompatWarning` is emitted and
  `_handle_mcp_action("mcp_tools_list", …)` succeeds.
- `npm run test` before opening the PR.

## Timeline

**Corrected 2026-09-12 (original draft said "~2 months out" — that was wrong):
the shim layer is removed upstream on 2026-09-14, i.e. two days from now.**
Concretely:

- The `_run_on_mcp_loop` break (P0) is effective on hermes-agent 0.21.2
  **today**: managed-MCP shutdown is a no-op and every MCP management action
  returns `{"error": "MCP tool module not available"}`.
- The `set/reset_current_session_key` deprecation (P0b) still resolves through
  the shim until 2026-09-14 (with a one-time `HermesPluginCompatWarning` per
  process); from that date it raises `ImportError` and, because
  `bridge_pool.py:1190-1193` wraps the import and `register_gateway_notify` in
  one `except Exception: pass`, gateway approval routing degrades **silently**.
- The P1 shim-only symbols (`discover_mcp_tools`, `register_mcp_servers`)
  fail the same way on 2026-09-14.

The compat wiring (steps 1-3) must therefore land **before 2026-09-14** —
not "before the next release that claims 0.21.x support". If that is not
feasible, the minimum stopgap is to flip the two `bridge_server.py` /
`bridge_pool.py` imports to the new module paths unconditionally and accept
losing support for pre-0.21 Hermes installs.
