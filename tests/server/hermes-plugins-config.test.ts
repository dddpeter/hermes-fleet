import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import YAML from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execHermesMock } = vi.hoisted(() => ({ execHermesMock: vi.fn() }))

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermes: execHermesMock,
}))

describe('Hermes plugin configuration', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    execHermesMock.mockReset()
    execHermesMock.mockRejectedValue(new Error('hermes CLI unavailable'))
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-plugins-config-'))
    process.env = { ...originalEnv }
    process.env.HERMES_HOME = join(tempDir, 'home')
    process.env.HERMES_AGENT_BASE_HOME = ''
    delete process.env.HERMES_ENABLE_PROJECT_PLUGINS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  function writeUserPlugin(name = 'local-plugin'): void {
    const dir = join(process.env.HERMES_HOME!, 'plugins', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.yaml'), `name: ${name}\nkind: standalone\n`)
  }

  function writeBundledPlugin(name: string): void {
    const agentRoot = join(tempDir, 'agent')
    const dir = join(agentRoot, 'plugins', name)
    mkdirSync(join(agentRoot, 'hermes_cli'), { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(join(agentRoot, 'hermes_cli', 'plugins.py'), '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.yaml'), `name: ${name}\nkind: standalone\n`)
    process.env.HERMES_AGENT_ROOT = agentRoot
  }

  function readConfig() {
    return YAML.load(readFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), 'utf-8')) as any
  }

  function writeProfileConfig(content: string): void {
    mkdirSync(process.env.HERMES_HOME!, { recursive: true })
    writeFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), content)
  }

  it('enables standalone user plugins in the active profile config', async () => {
    writeUserPlugin()
    writeProfileConfig([
      'plugins:',
      '  disabled:',
      '    - local-plugin',
      '',
    ].join('\n'))

    const { setHermesPluginEnabled } = await import('../../packages/server/src/services/hermes/plugins')
    await expect(setHermesPluginEnabled(undefined, 'local-plugin', true)).resolves.toEqual({
      key: 'local-plugin',
      enabled: true,
    })

    expect(readConfig().plugins).toEqual({
      enabled: ['local-plugin'],
      disabled: [],
    })
  })

  it('disables standalone user plugins in the active profile config', async () => {
    writeUserPlugin()
    writeProfileConfig([
      'plugins:',
      '  enabled:',
      '    - local-plugin',
      '',
    ].join('\n'))

    const { setHermesPluginEnabled } = await import('../../packages/server/src/services/hermes/plugins')
    await expect(setHermesPluginEnabled(undefined, 'local-plugin', false)).resolves.toEqual({
      key: 'local-plugin',
      enabled: false,
    })

    expect(readConfig().plugins).toEqual({
      enabled: [],
      disabled: ['local-plugin'],
    })
  })

  it('rejects bundled plugins because they are managed by Hermes Agent', async () => {
    writeBundledPlugin('bundled-plugin')

    const { setHermesPluginEnabled } = await import('../../packages/server/src/services/hermes/plugins')
    await expect(setHermesPluginEnabled(undefined, 'bundled-plugin', false)).rejects.toThrow('cannot be managed')
  })

  it('merges enabled/disabled state across base home and profile config', async () => {
    const baseHome = join(tempDir, 'base')
    const profileHome = process.env.HERMES_HOME!
    process.env.HERMES_AGENT_BASE_HOME = baseHome

    const agentRoot = join(tempDir, 'agent')
    const dir = join(agentRoot, 'plugins', 'switchable')
    mkdirSync(join(agentRoot, 'hermes_cli'), { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(join(agentRoot, 'hermes_cli', 'plugins.py'), '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.yaml'), 'name: switchable\nkind: standalone\n')
    process.env.HERMES_AGENT_ROOT = agentRoot

    mkdirSync(baseHome, { recursive: true })
    writeFileSync(join(baseHome, 'config.yaml'), [
      'plugins:',
      '  enabled:',
      '    - switchable',
      '',
    ].join('\n'))
    writeProfileConfig([
      'plugins:',
      '  disabled:',
      '    - switchable',
      '',
    ].join('\n'))

    const { listHermesPlugins } = await import('../../packages/server/src/services/hermes/plugins')
    const result = await listHermesPlugins()

    expect(result.plugins.find(plugin => plugin.key === 'switchable')).toMatchObject({
      configStatus: 'disabled',
      effectiveStatus: 'disabled',
    })
  })
})
