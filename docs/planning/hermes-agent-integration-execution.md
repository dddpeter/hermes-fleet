# Hermes Agent Integration Roadmap — Execution Plan

Date: 2026-09-12
Status: In progress — companion to
[hermes-agent-integration-roadmap.md](hermes-agent-integration-roadmap.md).
This document turns the roadmap's priorities into concrete, executable
workstreams with verified upstream facts. Items are ordered by dependency and
risk, not by size.

## Verified upstream facts (0.21.2, re-checked 2026-09-12)

These correct the initial analysis and constrain the designs below:

- **CLI `--json` coverage is narrower than first reported.**
  `add_json_flag` is present on: `plugins` (list/search/validate),
  `skills`, `sessions pinned` **only** (NOT `sessions list`),
  `approvals`, `config`, `security`, `verify`, `computer_use`,
  `prompt_size`. There is **no `--json`** on `profile`, `logs`, or
  `gateway` subcommands.
- `hermes plugins list --json` emits a JSON array with keys
  `name / status / version / description / source / removed`
  (`hermes_cli/plugins_cmd.py:1341`).
- `hermes_cli.plugins` was decomposed: `_get_disabled_plugins` /
  `_get_enabled_plugins` now live in `hermes_cli/plugins_discovery.py`
  (`:80`, `:90`) and survive in `hermes_cli.plugins` only via an incidental
  re-import (`plugins.py:44`); `PluginManager._scan_directory` remains a
  method (`plugins.py:1417`). Private names have no compat promise.
- The gateway control socket (`gateway/control_socket.py`,
  `CONTROL_PROTOCOL_VERSION = 1`) supports `identify` and `status` verbs:
  POSIX `$HERMES_HOME/gateway.sock`, Windows named pipe
  `\\.\pipe\hermes-gateway-<hash>`, one JSON line in / one line out.
- `run_agent.py` has no structured output (fire-based demo entry point);
  official programmatic surfaces are TUI Gateway JSON-RPC, ACP, and the
  OpenAI-compatible API server (`/v1/runs` lifecycle, `GET /v1/capabilities`).

## Workstream A — plugin enumeration via official contract (P1) — **Done 2026-09-12**

**Goal:** delete the embedded Python in `services/hermes/plugins.ts`
(imports `hermes_cli.plugins.PluginManager` privates).

**Shipped design (supersedes the steps below):** `hermes plugins list --json`
only exposes `name/status/version/description/source/removed`, which would
have regressed the Web UI's richer plugin detail (kind, author, path,
provides_tools/hooks, requires_env). Instead the enumeration now reads the
documentated plugin contract directly: it scans the documented discovery
directories for `plugin.yaml` manifests in TypeScript, mirroring upstream
`scan_directory` / `parse_manifest_file` semantics (category recursion, key
prefixing, kind normalization); enabled/disabled status is computed from the
base+profile `config.yaml` exactly as before; and pip entry-point plugins —
invisible to filesystem scans — are enumerated via the official
`hermes plugins list --json` CLI (non-fatal warning on failure). No Hermes
internal Python API is imported anymore.

Tests: `hermes-plugins-env.test.ts` / `hermes-plugins-config.test.ts`
rewritten to real-filesystem fixtures (platform-neutral, CLI mocked), plus a
guard assertion that `plugins.ts` contains no `PluginManager` /
`_scan_directory` / embedded Python. Type-check clean; full suite failure set
improved vs. the pre-change baseline.

Original steps (for reference):
1. Add a `hermes-plugins-list.ts` helper that runs
   `hermes plugins list --json` with the profile's `HERMES_HOME` (same env
   pattern as `hermes-process.ts`) and parses the array
   (`name/status/version/description/source/removed`).
2. Map `status` values onto the Web UI's enabled/disabled model; derive
   install location (`$HERMES_HOME/plugins/<name>` vs bundled) from `source`.
3. Replace `plugins.ts`'s `spawnPython` enumeration path; keep the existing
   enable/disable flow (which writes `config.yaml` via `safeFileStore`) —
   only enumeration moves to the CLI.
4. Port the existing plugin tests to stub `hermes plugins list --json`
   output instead of stubbed Python.
5. Delete the embedded Python source string; add a guard test asserting
   `plugins.ts` no longer contains `PluginManager` / `_scan_directory`.

Risk: the Web UI currently shows richer per-plugin detail than the CLI JSON
provides (e.g. tool lists). If a field is missing, degrade to "unknown"
rather than re-adding private imports; file the gap for the
`hermes plugins capabilities <name>` command instead.

## Workstream B — stop parsing CLI stdout (P1, split by feasibility) — **Done 2026-09-12**

Because `profile`/`logs`/`gateway` lack `--json`, this split into four fixes.
All four shipped:

- **B1 (shipped).** `listProfiles` / `getProfile` in `hermes-cli.ts` no longer
  call `hermes profile list/show`. Profile facts are derived from the profile
  directory exactly like upstream `ProfileInfo` (`hermes_cli/profiles.py`):
  model/provider from the profile's `config.yaml`, `skills` counted from
  `SKILL.md` files (mirroring upstream's excluded/support dir rules), `.env` /
  `SOUL.md` existence from the filesystem, aliases from the `~/.local/bin`
  wrapper scripts (`hermes -p <profile>` needle, same custom-alias-wins
  semantics), and gateway status from the Workstream B3 probe.
- **B2 (shipped).** `listLogFiles` enumerates `<HERMES_HOME>/logs/*.log`
  directly (size + mtime from `stat`) instead of the `hermes logs list`
  regex that only recognized a four-name whitelist.
- **B3 (shipped).** New `gateway-control-socket.ts` speaks the gateway
  control protocol v1 (`identify`/`status`, one JSON line each; POSIX
  `$HERMES_HOME/gateway.sock` + `gateway.sock.path` pointer fallback,
  Windows named pipe `\\.\pipe\hermes-gateway-<sha256[:16]>` of the normcased
  home). `gateway-autostart.ts` now probes: control socket → pid files →
  (last resort only) the `gateway status` CLI text. The
  `hermes profile list` output parsing (`profile-list-parser.ts`) is deleted.
- **B4 (shipped).** `parseSessionExport` logs a warning for every
  non-JSON line instead of silently skipping, so upstream format changes are
  observable in logs.

Original sub-items (for reference):

- **B1. Profile data from files we already own.** `profile list` /
  `profile show` parsing (`profile-list-parser.ts`,
  `hermes-cli.ts:625-645`) reads data hermes-fleet can derive directly:
  profile directories under `<HERMES_HOME>/profiles/`, `active_profile`
  file, and each profile's `config.yaml` (model/provider already read by
  `hermes-cli.ts:569-583`). Rewrite the parsers to read those sources;
  keep the CLI call only as a last-resort fallback.
- **B2. Log catalog from the filesystem.** `hermes logs list` regex
  (`hermes-cli.ts:504-509`, hard-coded to four log names) → enumerate log
  files from the profile's log directory directly; drop the name whitelist.
- **B3. Gateway status via control socket (P2 item, do with B).**
  Replace "gateway is running" sentence matching
  (`gateway-autostart.ts:316-327`) and `gateway.pid` file heuristics with a
  control-socket `status` probe (JSON in/out, protocol version 1). Windows
  uses the named pipe form. Keep the CLI text check as fallback when the
  socket is absent (older agent versions).
- **B4. `sessions export` NDJSON** (`hermes-cli.ts:220-232`): no `--json`
  exists for `sessions list`; keep NDJSON parsing but stop silently skipping
  unmatched lines — log a warning line so breakage is observable.

Each sub-item ships with fixture tests updated from real 0.21.2 output and a
note in `docs/harness/validation.md` if a new check is added.

## Workstream C — capability-aware version handling (P2) — **Done 2026-09-12**

1. **Worker-start version + compat logging (shipped).** `bridge_runtime.py`
   now logs `hermes_agent_version` (from `hermes_cli.__version__`) and
   `hermes_compat_fallbacks` (new `hermes_compat.fallbacks_used()`, recording
   every symbol resolved via the old-location fallback) in the
   `bridge.worker.initialized` payload. The server also logs the resolved
   agent version once per start (`[bootstrap] hermes-agent version: …`, via a
   new 5-minute-cached `hermesCli.getVersion()`).
2. **Capability probing:** `GET /v1/capabilities` only helps when the profile
   API server is running, which the bridge-mode Web UI can't assume.
   Instead: the write-gate keeps its real probe (support files + import
   check), and the TUI Gateway's `gateway.capabilities` RPC is noted as the
   probe to use once Workstream D's pilot lands.
3. **Custom provider writes (shipped, adjusted design).** The legacy
   `custom_providers:` list is still a supported read format upstream (the
   v12 `providers:` dict and the list are both read and deduplicated), so an
   unconditional schema switch would break older installs for no gain.
   `controllers/hermes/providers.ts` instead now **follows the shape the
   profile's config.yaml already uses** (dict profiles keep the dict, legacy
   profiles keep the list) via a shared `upsertCustomProviderEntry` helper,
   and `update` finds entries in either form. The same entry can never land
   in both forms (upstream would surface it twice).

## Workstream D — bridge transport migration design spike (P3) — **Done 2026-09-12**

Deliverable: [hermes-bridge-transport-spike.md](hermes-bridge-transport-spike.md)
— full action-parity table (every `AgentBridgeClient` action mapped to a
registered TUI Gateway method from the 0.21.2 source), gaps/risks
(multi-session fan-out, worker lifecycle, protocol stability, group chat),
and a three-step cut-over plan. Recommendation: TUI Gateway JSON-RPC as
primary target, ACP as fallback, pilot behind an env flag before any cutover.

## Sequencing

1. Compat fix (sibling doc) — **done 2026-09-12** (code + tests + README).
2. Workstream A — **done 2026-09-12** (manifest-based enumeration).
3. Workstream B1-B4 — **done 2026-09-12** (filesystem reads, control socket,
   observable NDJSON parsing; `profile-list-parser.ts` deleted).
4. Workstream C — **done 2026-09-12** (worker version + compat-fallback
   logging, cached server-side version, shape-following provider writes).
5. Workstream D — **done 2026-09-12** (spike:
   [hermes-bridge-transport-spike.md](hermes-bridge-transport-spike.md)).
   Next concrete step is the gated TUI Gateway pilot from the spike's
   recommendation; everything before that is maintenance-only.
