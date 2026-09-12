import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execHermesMock } = vi.hoisted(() => ({ execHermesMock: vi.fn() }))

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermes: execHermesMock,
}))

describe('Hermes plugin discovery (manifest-based)', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    execHermesMock.mockReset()
    execHermesMock.mockRejectedValue(new Error('hermes CLI unavailable'))
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-plugins-env-'))
    process.env = { ...originalEnv }
    process.env.HERMES_HOME = join(tempDir, 'home')
    process.env.HERMES_AGENT_BASE_HOME = ''
    delete process.env.HERMES_BUNDLED_PLUGINS
    delete process.env.HERMES_ENABLE_PROJECT_PLUGINS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  function installAgentRoot(): string {
    const agentRoot = join(tempDir, 'agent')
    mkdirSync(join(agentRoot, 'hermes_cli'), { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(join(agentRoot, 'hermes_cli', 'plugins.py'), '')
    process.env.HERMES_AGENT_ROOT = agentRoot
    return agentRoot
  }

  function writeManifest(dir: string, data: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.yaml'), [
      '---',
      ...Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      '',
    ].join('\n'))
  }

  async function loadPluginsModule() {
    return import('../../packages/server/src/services/hermes/plugins')
  }

  it('no longer embeds Hermes internal Python imports', async () => {
    const source = readFileSync(
      'packages/server/src/services/hermes/plugins.ts',
      'utf8',
    )
    expect(source).not.toContain('PluginManager')
    expect(source).not.toContain('_scan_directory')
    expect(source).not.toContain('PYTHON_BRIDGE')
  })

  it('enumerates bundled, platform, user, and category plugins from manifests', async () => {
    const agentRoot = installAgentRoot()
    const home = process.env.HERMES_HOME!

    writeManifest(join(agentRoot, 'plugins', 'disk-cleanup'), {
      name: 'disk-cleanup',
      kind: 'backend',
      version: '2.0.0',
      description: 'clean temp files',
      author: 'someone',
      provides_tools: ['cleanup_tmp'],
      provides_hooks: ['post_tool_call'],
      requires_env: ['TMP_DIR'],
    })
    writeManifest(join(agentRoot, 'plugins', 'platforms', 'telegram'), {
      name: 'telegram',
      kind: 'platform',
      description: 'telegram adapter',
    })
    writeManifest(join(agentRoot, 'plugins', 'model-providers', 'acme'), {
      name: 'acme',
      kind: 'model-provider',
      description: 'acme provider',
    })
    writeManifest(join(home, 'plugins', 'local-plugin'), {
      name: 'local-plugin',
      kind: 'standalone',
      description: 'user plugin',
      provides_tools: ['do_thing', 42],
    })

    const { listHermesPlugins } = await loadPluginsModule()
    const result = await listHermesPlugins()

    const byKey = new Map(result.plugins.map(plugin => [plugin.key, plugin]))
    expect(byKey.get('disk-cleanup')).toMatchObject({
      kind: 'backend',
      source: 'bundled',
      configStatus: 'auto',
      effectiveStatus: 'auto-active',
      version: '2.0.0',
      providesTools: ['cleanup_tmp'],
      providesHooks: ['post_tool_call'],
      requiresEnv: ['TMP_DIR'],
    })
    expect(byKey.get('telegram')).toMatchObject({
      kind: 'platform',
      source: 'bundled',
      configStatus: 'auto',
      effectiveStatus: 'auto-active',
    })
    expect(byKey.get('model-providers/acme')).toMatchObject({
      kind: 'model-provider',
      source: 'bundled',
      configStatus: 'provider-managed',
      effectiveStatus: 'provider-managed',
    })
    expect(byKey.get('local-plugin')).toMatchObject({
      kind: 'standalone',
      source: 'user',
      configStatus: 'not-enabled',
      effectiveStatus: 'inactive',
      providesTools: ['do_thing', '42'],
    })
  })

  it('treats undeclared platform-plugin directories recursively and warns on unknown kinds', async () => {
    const agentRoot = installAgentRoot()
    writeManifest(join(agentRoot, 'plugins', 'odd-one'), { kind: 'not-a-kind' })

    const { listHermesPlugins } = await loadPluginsModule()
    const result = await listHermesPlugins()

    expect(result.plugins.find(plugin => plugin.key === 'odd-one')?.kind).toBe('standalone')
    expect(result.warnings.some(warning => warning.includes("unknown kind 'not-a-kind'"))).toBe(true)
  })

  it('adds pip entry-point plugins from the official CLI without duplicating directory plugins', async () => {
    const agentRoot = installAgentRoot()
    const home = process.env.HERMES_HOME!
    writeManifest(join(home, 'plugins', 'local-plugin'), { name: 'local-plugin' })

    execHermesMock.mockResolvedValue({
      stdout: JSON.stringify([
        { name: 'local-plugin', status: 'enabled', version: '', description: '', source: 'user', removed: '' },
        {
          name: 'pip-plugin',
          status: 'enabled',
          version: '1.2.3',
          description: 'installed via pip',
          source: 'entrypoint',
          removed: '',
        },
      ]),
      stderr: '',
    })

    const { listHermesPlugins } = await loadPluginsModule()
    const result = await listHermesPlugins()

    const pips = result.plugins.filter(plugin => plugin.source === 'entrypoint')
    expect(pips.map(plugin => plugin.key)).toEqual(['pip-plugin'])
    expect(pips[0]).toMatchObject({ name: 'pip-plugin', version: '1.2.3' })
    expect(result.plugins.filter(plugin => plugin.key === 'local-plugin')).toHaveLength(1)
    expect(existsSync(join(agentRoot, 'run_agent.py'))).toBe(true)
  })

  it('keeps discovery working when the CLI probe fails', async () => {
    installAgentRoot()

    const { listHermesPlugins } = await loadPluginsModule()
    const result = await listHermesPlugins()

    expect(result.plugins).toEqual([])
    expect(result.warnings.some(warning => warning.includes('hermes plugins list --json'))).toBe(true)
  })
})
