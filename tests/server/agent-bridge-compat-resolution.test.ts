import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const BRIDGE_PYTHON_DIR = 'packages/server/src/services/hermes/agent-bridge/python'

function runPython(script: string): string {
  try {
    return execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python compat resolution script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location(
    "hermes_compat",
    "packages/server/src/services/hermes/agent-bridge/python/hermes_compat.py",
)
compat = importlib.util.module_from_spec(spec)
sys.modules["hermes_compat"] = compat
spec.loader.exec_module(compat)
import_attr = compat.import_attr

tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg

def make_module(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module

def drop_modules(*names):
    for name in names:
        sys.modules.pop(name, None)

def expect_import_error(fn, *fragments):
    try:
        fn()
    except ImportError as exc:
        for fragment in fragments:
            assert fragment in str(exc), f"{fragment!r} missing from: {exc}"
    else:
        raise AssertionError("expected ImportError")
`

describe('agent bridge Python compat resolution', () => {
  it('resolves moved symbols from their new module when present', () => {
    runPython(String.raw`
${harness}

def new_run_on_mcp_loop(): return "new"
def new_discover(): return "new"
def new_register(): return "new"
def new_set_session_key(): return "new"
def new_reset_session_key(): return "new"

make_module("tools.mcp_tool_loop", _run_on_mcp_loop=new_run_on_mcp_loop)
make_module(
    "tools.mcp_tool_discovery",
    discover_mcp_tools=new_discover,
    register_mcp_servers=new_register,
)
make_module("tools.approval_context",
    set_current_session_key=new_set_session_key,
    reset_current_session_key=new_reset_session_key,
)

def old_run_on_mcp_loop(): return "old"
def old_discover(): return "old"
def old_register(): return "old"
def old_set_session_key(): return "old"
def old_reset_session_key(): return "old"

make_module("tools.mcp_tool", _run_on_mcp_loop=old_run_on_mcp_loop)
make_module("tools.approval",
    set_current_session_key=old_set_session_key,
    reset_current_session_key=old_reset_session_key,
)

assert import_attr("tools.mcp_tool_loop", "_run_on_mcp_loop", "tools.mcp_tool") is new_run_on_mcp_loop
assert import_attr("tools.mcp_tool_discovery", "discover_mcp_tools", "tools.mcp_tool") is new_discover
assert import_attr("tools.mcp_tool_discovery", "register_mcp_servers", "tools.mcp_tool") is new_register
assert import_attr("tools.approval_context", "set_current_session_key", "tools.approval") is new_set_session_key
assert import_attr("tools.approval_context", "reset_current_session_key", "tools.approval") is new_reset_session_key
`)
  })

  it('falls back to the pre-decomposition location for older Hermes installs', () => {
    runPython(String.raw`
${harness}

def old_run_on_mcp_loop(): return "old"
def old_discover(): return "old"
def old_register(): return "old"
def old_set_session_key(): return "old"
def old_reset_session_key(): return "old"

make_module("tools.mcp_tool",
    _run_on_mcp_loop=old_run_on_mcp_loop,
    discover_mcp_tools=old_discover,
    register_mcp_servers=old_register,
)
make_module("tools.approval",
    set_current_session_key=old_set_session_key,
    reset_current_session_key=old_reset_session_key,
)

assert import_attr("tools.mcp_tool_loop", "_run_on_mcp_loop", "tools.mcp_tool") is old_run_on_mcp_loop
assert import_attr("tools.mcp_tool_discovery", "discover_mcp_tools", "tools.mcp_tool") is old_discover
assert import_attr("tools.mcp_tool_discovery", "register_mcp_servers", "tools.mcp_tool") is old_register
assert import_attr("tools.approval_context", "set_current_session_key", "tools.approval") is old_set_session_key
assert import_attr("tools.approval_context", "reset_current_session_key", "tools.approval") is old_reset_session_key

fallbacks = compat.fallbacks_used()
assert {entry["name"] for entry in fallbacks} == {
    "_run_on_mcp_loop", "discover_mcp_tools", "register_mcp_servers",
    "set_current_session_key", "reset_current_session_key",
}, fallbacks
assert all(entry["resolved_from"] == "tools.mcp_tool" or entry["resolved_from"] == "tools.approval" for entry in fallbacks), fallbacks

expect_import_error(
    lambda: import_attr("tools.missing_new", "symbol", "tools.missing_old"),
    "tools.missing_old",
)
`)
  })

  it('raises ImportError naming both modules when the symbol exists in neither', () => {
    runPython(String.raw`
${harness}

make_module("tools.empty_new")
make_module("tools.empty_old")

expect_import_error(
    lambda: import_attr("tools.empty_new", "missing_symbol", "tools.empty_old"),
    "missing_symbol",
    "tools.empty_new",
    "tools.empty_old",
)
`)
  })
})

describe('agent bridge Python raw-import regression guard', () => {
  const files = [
    'bridge_pool.py',
    'bridge_runtime.py',
    'bridge_server.py',
    'bridge_transport.py',
    'bridge_broker.py',
    'hermes_bridge.py',
  ]

  const movedFromToolsMcpTool = ['_run_on_mcp_loop', 'discover_mcp_tools', 'register_mcp_servers']
  const movedFromToolsApproval = ['set_current_session_key', 'reset_current_session_key']

  it('keeps moved Hermes symbols routed through hermes_compat.import_attr', () => {
    expect(readFileSync(`${BRIDGE_PYTHON_DIR}/hermes_compat.py`, 'utf-8'))
      .toContain('def import_attr')

    for (const file of files) {
      const source = readFileSync(`${BRIDGE_PYTHON_DIR}/${file}`, 'utf-8')
      for (const line of source.split('\n')) {
        const mcpImport = line.match(/from\s+tools\.mcp_tool\s+import\s+(.+)/)
        if (mcpImport) {
          for (const name of movedFromToolsMcpTool) {
            expect(
              mcpImport[1],
              `${file}: "${name}" moved to tools.mcp_tool_loop / tools.mcp_tool_discovery; resolve it via hermes_compat.import_attr instead of importing it from tools.mcp_tool`,
            ).not.toContain(name)
          }
        }
        const approvalImport = line.match(/from\s+tools\.approval\s+import\s+(.+)/)
        if (approvalImport) {
          for (const name of movedFromToolsApproval) {
            expect(
              approvalImport[1],
              `${file}: "${name}" moved to tools.approval_context; resolve it via hermes_compat.import_attr instead of importing it from tools.approval`,
            ).not.toContain(name)
          }
        }
      }
    }
  })

  it('wires every documented moved symbol through hermes_compat', () => {
    const pool = readFileSync(`${BRIDGE_PYTHON_DIR}/bridge_pool.py`, 'utf-8')
    const runtime = readFileSync(`${BRIDGE_PYTHON_DIR}/bridge_runtime.py`, 'utf-8')
    const server = readFileSync(`${BRIDGE_PYTHON_DIR}/bridge_server.py`, 'utf-8')

    expect(pool).toMatch(/import_attr\("tools\.approval_context",\s*"set_current_session_key",\s*"tools\.approval"\)/)
    expect(pool).toMatch(/import_attr\("tools\.approval_context",\s*"reset_current_session_key",\s*"tools\.approval"\)/)
    expect(runtime).toMatch(/import_attr\("tools\.mcp_tool_discovery",\s*"discover_mcp_tools",\s*"tools\.mcp_tool"\)/)
    expect(server).toMatch(/import_attr\("tools\.mcp_tool_loop",\s*"_run_on_mcp_loop",\s*"tools\.mcp_tool"\)/)
    expect(server).toMatch(/import_attr\("tools\.mcp_tool_discovery",\s*"discover_mcp_tools",\s*"tools\.mcp_tool"\)/)
    expect(server).toMatch(/import_attr\("tools\.mcp_tool_discovery",\s*"register_mcp_servers",\s*"tools\.mcp_tool"\)/)
  })
})
