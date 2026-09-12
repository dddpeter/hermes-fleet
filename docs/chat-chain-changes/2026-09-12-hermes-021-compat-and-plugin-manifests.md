---
date: 2026-09-12
pr: TBD
commit: pending
feature: Hermes Agent 0.21 import compatibility + manifest-based plugin enumeration
impact: No chat protocol change. Bridge Python resolves Hermes symbols that moved in the Sep 2026 upstream decomposition through `hermes_compat.py::import_attr` (fixes silently broken MCP management and a scheduled approval-routing break), and Web UI plugin enumeration reads the documented `plugin.yaml` contract plus `hermes plugins list --json` instead of importing Hermes private Python APIs.
---

Hermes Agent 0.21.2 moved `_run_on_mcp_loop` to `tools.mcp_tool_loop` (not
covered by the upstream PLUGIN-COMPAT shims, so MCP management from the Web UI
was already broken) and `set_current_session_key` / `reset_current_session_key`
to `tools.approval_context` (shimmed only until 2026-09-14, after which gateway
approval routing would degrade silently).

- `agent-bridge/python/hermes_compat.py` adds a single
  `import_attr(new_module, name, old_module)` resolver; the five affected call
  sites in `bridge_pool.py`, `bridge_runtime.py`, and `bridge_server.py` are
  wired through it (new location first, pre-decomposition fallback for older
  Hermes installs).
- `tests/server/agent-bridge-compat-resolution.test.ts` covers the resolution
  trees and guards against raw imports of known-moved symbols.
- `services/hermes/plugins.ts` no longer embeds Python importing
  `hermes_cli.plugins` privates. It scans the documented plugin discovery
  directories for `plugin.yaml` manifests (mirroring upstream
  `scan_directory`/`parse_manifest_file` semantics), computes
  enabled/disabled status from profile config, and enumerates pip entry-point
  plugins via the official `hermes plugins list --json` CLI.
- Audit and follow-up roadmap:
  `docs/planning/hermes-agent-compat-0.21.md`,
  `docs/planning/hermes-agent-integration-roadmap.md`,
  `docs/planning/hermes-agent-integration-execution.md`.
