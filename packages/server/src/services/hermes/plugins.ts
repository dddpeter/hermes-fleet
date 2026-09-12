import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'js-yaml'
import { getActiveProfileDir, getHermesBaseDir, getProfileDir } from './hermes-profile'
import { resolveAgentBridgeCommand } from './agent-bridge/manager'
import { execHermes } from './hermes-process'
import { safeFileStore } from '../safe-file-store'

export type HermesPluginSource = 'bundled' | 'user' | 'project' | 'entrypoint'
export type HermesPluginKind = 'standalone' | 'backend' | 'exclusive' | 'platform' | 'model-provider'
export type HermesPluginConfigStatus = 'enabled' | 'disabled' | 'not-enabled' | 'auto' | 'provider-managed'
export type HermesPluginEffectiveStatus = 'enabled' | 'disabled' | 'inactive' | 'auto-active' | 'provider-managed'

export interface HermesPluginInfo {
  key: string
  name: string
  kind: HermesPluginKind | string
  source: HermesPluginSource | string
  configStatus: HermesPluginConfigStatus
  effectiveStatus: HermesPluginEffectiveStatus
  version: string
  description: string
  author: string
  path: string
  providesTools: string[]
  providesHooks: string[]
  requiresEnv: Array<string | Record<string, unknown>>
}

export interface HermesPluginsMetadata {
  hermesAgentRoot: string
  pythonExecutable: string
  cwd: string
  projectPluginsEnabled: boolean
}

export interface HermesPluginsResponse {
  plugins: HermesPluginInfo[]
  warnings: string[]
  metadata: HermesPluginsMetadata
}

export interface HermesPluginMutationResult {
  key: string
  enabled: boolean
}

// Plugin enumeration reads the documented plugin contract only: manifest files
// (plugin.yaml) in the documented discovery directories, plus the official
// `hermes plugins list --json` CLI for pip entry-point plugins. Hermes internal
// Python APIs are deliberately not imported — internal import paths are not a
// stable API (see docs/planning/hermes-agent-integration-execution.md).
// Upstream scan semantics: hermes_cli/plugins_discovery.py::scan_directory and
// hermes_cli/plugins_manifest.py::parse_manifest_file (hermes-agent 0.21.2).

const VALID_PLUGIN_KINDS = new Set(['standalone', 'backend', 'exclusive', 'platform', 'model-provider'])

const ENTRYPOINT_CLI_TIMEOUT_MS = 15000

interface ScannedManifest {
  key: string
  name: string
  kind: string
  source: string
  version: string
  description: string
  author: string
  path: string
  providesTools: string[]
  providesHooks: string[]
  requiresEnv: Array<string | Record<string, unknown>>
}

function extractError(err: unknown): string {
  const errAny = err as { message?: string; stdout?: unknown; stderr?: unknown }
  const stdout = typeof errAny?.stdout === 'string' ? errAny.stdout.trim() : ''
  const stderr = typeof errAny?.stderr === 'string' ? errAny.stderr.trim() : ''
  return [errAny?.message, stdout, stderr].filter(Boolean).join('\n')
}

function envEnabled(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === '1'
    || ['true', 'yes', 'on'].includes((process.env[name] || '').trim().toLowerCase())
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' || typeof item === 'number')
    .map(item => String(item))
}

function coerceEnvList(value: unknown): Array<string | Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string | Record<string, unknown> =>
    typeof item === 'string' || (item !== null && typeof item === 'object'))
}

function readManifestList(data: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function normalizeKind(data: Record<string, unknown>, key: string, warnings: string[]): string {
  const raw = data.kind
  const kind = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!kind) return 'standalone'
  if (!VALID_PLUGIN_KINDS.has(kind)) {
    warnings.push(`plugin ${key}: unknown kind '${raw}'; treating as 'standalone'`)
    return 'standalone'
  }
  return kind
}

function parseManifestFile(
  manifestFile: string,
  pluginDir: string,
  source: string,
  prefix: string,
  warnings: string[],
): ScannedManifest | null {
  let data: unknown
  try {
    const text = readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')
    data = YAML.load(text)
  } catch (exc) {
    warnings.push(`manifest at ${pluginDir}: ${exc}`)
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (data !== null && data !== undefined) {
      warnings.push(`manifest at ${pluginDir}: not a mapping; skipped`)
    }
    return null
  }
  const manifest = data as Record<string, unknown>
  const dirName = pluginDir.split(/[\\/]/).pop() || pluginDir
  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : dirName
  const key = prefix ? `${prefix}/${dirName}` : name
  return {
    key,
    name,
    kind: normalizeKind(manifest, key, warnings),
    source,
    version: manifest.version === undefined || manifest.version === null ? '' : String(manifest.version),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    author: typeof manifest.author === 'string' ? manifest.author : '',
    path: pluginDir,
    providesTools: coerceStringList(readManifestList(manifest, 'provides_tools', 'tools')),
    providesHooks: coerceStringList(readManifestList(manifest, 'provides_hooks', 'hooks')),
    requiresEnv: coerceEnvList(readManifestList(manifest, 'requires_env')),
  }
}

function scanDirectory(
  root: string,
  source: string,
  skipNames: ReadonlySet<string>,
  warnings: string[],
  prefix = '',
  depth = 0,
): ScannedManifest[] {
  if (!root || !existsSync(root)) return []
  let children: Array<import('fs').Dirent>
  try {
    children = readdirSync(root, { withFileTypes: true })
  } catch (exc) {
    warnings.push(`${source} plugins at ${root}: ${exc}`)
    return []
  }
  const manifests: ScannedManifest[] = []
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory()) continue
    if (depth === 0 && skipNames.has(child.name)) continue
    const childPath = join(root, child.name)
    const manifestFile = ['plugin.yaml', 'plugin.yml']
      .map(file => join(childPath, file))
      .find(file => existsSync(file))
    if (manifestFile) {
      const manifest = parseManifestFile(manifestFile, childPath, source, prefix, warnings)
      if (manifest) manifests.push(manifest)
    } else if (existsSync(join(childPath, 'plugin.json'))) {
      warnings.push(`portable plugin package at ${childPath}: plugin.json manifests are not enumerated; skipped`)
    } else if (depth < 1) {
      const subPrefix = prefix ? `${prefix}/${child.name}` : child.name
      manifests.push(...scanDirectory(childPath, source, skipNames, warnings, subPrefix, depth + 1))
    }
  }
  return manifests
}

function readConfigYaml(home: string | undefined, warnings: string[]): Record<string, unknown> {
  if (!home) return {}
  try {
    const configPath = join(home, 'config.yaml')
    if (!existsSync(configPath)) return {}
    const parsed = YAML.load(readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (exc) {
    warnings.push(`plugin config at ${home}: ${exc}`)
    return {}
  }
}

function configPluginsList(config: Record<string, unknown>, key: string): Set<string> | null {
  const plugins = config.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null
  const value = (plugins as Record<string, unknown>)[key]
  return Array.isArray(value) ? new Set(value.map(item => String(item))) : null
}

function mergedPluginConfig(
  hermesBaseHome: string,
  hermesHome: string,
  warnings: string[],
): { disabled: Set<string>; enabled: Set<string> | null } {
  const homes: string[] = []
  for (const home of [hermesBaseHome, hermesHome]) {
    if (home && !homes.includes(home)) homes.push(home)
  }

  const disabled = new Set<string>()
  const enabled = new Set<string>()
  let sawEnabledKey = false
  for (const home of homes) {
    const config = readConfigYaml(home, warnings)
    const enabledValue = configPluginsList(config, 'enabled')
    if (enabledValue) {
      sawEnabledKey = true
      for (const name of enabledValue) {
        enabled.add(name)
        disabled.delete(name)
      }
    }
    const disabledValue = configPluginsList(config, 'disabled')
    if (disabledValue) {
      for (const name of disabledValue) {
        disabled.add(name)
        enabled.delete(name)
      }
    }
  }
  return { disabled, enabled: sawEnabledKey ? enabled : null }
}

async function entrypointManifests(hermesHome: string, warnings: string[]): Promise<ScannedManifest[]> {
  let stdout: string
  try {
    ({ stdout } = await execHermes(['plugins', 'list', '--json'], {
      env: { ...process.env, HERMES_HOME: hermesHome },
      timeout: ENTRYPOINT_CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }))
  } catch (err) {
    warnings.push(`hermes plugins list --json: ${extractError(err)}`)
    return []
  }
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch (exc) {
    warnings.push(`hermes plugins list --json output was not JSON: ${exc}`)
    return []
  }
  if (!Array.isArray(rows)) {
    warnings.push('hermes plugins list --json output was not a JSON array')
    return []
  }
  const manifests: ScannedManifest[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    // Directory plugins are enumerated natively above; only pip entry-point
    // plugins (invisible to filesystem scans) are taken from the CLI.
    if (entry.source !== 'entrypoint') continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name) continue
    if (entry.removed) {
      warnings.push(`plugin ${name}: ${String(entry.removed)}`)
    }
    manifests.push({
      key: name,
      name,
      kind: 'standalone',
      source: 'entrypoint',
      version: entry.version === undefined || entry.version === null ? '' : String(entry.version),
      description: typeof entry.description === 'string' ? entry.description : '',
      author: '',
      path: '',
      providesTools: [],
      providesHooks: [],
      requiresEnv: [],
    })
  }
  return manifests
}

export async function listHermesPlugins(profile?: string): Promise<HermesPluginsResponse> {
  const command = resolveAgentBridgeCommand()
  const agentRoot = command.agentRoot || ''
  const hermesHome = profile ? getProfileDir(profile) : getActiveProfileDir()
  const hermesBaseHome = getHermesBaseDir()
  const warnings: string[] = []
  const projectPluginsEnabled = envEnabled('HERMES_ENABLE_PROJECT_PLUGINS')

  const bundledRoot = process.env.HERMES_BUNDLED_PLUGINS?.trim() || (agentRoot ? join(agentRoot, 'plugins') : '')
  const manifests: ScannedManifest[] = [
    ...scanDirectory(bundledRoot, 'bundled', new Set(['platforms']), warnings),
    ...scanDirectory(bundledRoot ? join(bundledRoot, 'platforms') : '', 'bundled', new Set(), warnings),
    ...scanDirectory(join(hermesHome, 'plugins'), 'user', new Set(), warnings),
    ...(projectPluginsEnabled
      ? scanDirectory(join(process.cwd(), '.hermes', 'plugins'), 'project', new Set(), warnings)
      : []),
  ]
  manifests.push(...await entrypointManifests(hermesHome, warnings))

  const winners = new Map<string, ScannedManifest>()
  for (const manifest of manifests) {
    winners.set(manifest.key || manifest.name, manifest)
  }

  const { disabled, enabled } = mergedPluginConfig(hermesBaseHome, hermesHome, warnings)
  const enabledSet = enabled ?? new Set<string>()

  const plugins: HermesPluginInfo[] = Array.from(winners.entries())
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([key, manifest]) => {
      const disabledMatch = disabled.has(key) || disabled.has(manifest.name)
      const enabledMatch = enabledSet.has(key) || enabledSet.has(manifest.name)

      let configStatus: HermesPluginConfigStatus
      let effectiveStatus: HermesPluginEffectiveStatus
      if (disabledMatch) {
        configStatus = 'disabled'
        effectiveStatus = 'disabled'
      } else if (manifest.kind === 'exclusive' || manifest.kind === 'model-provider') {
        configStatus = 'provider-managed'
        effectiveStatus = 'provider-managed'
      } else if (manifest.source === 'bundled' && (manifest.kind === 'backend' || manifest.kind === 'platform')) {
        configStatus = 'auto'
        effectiveStatus = 'auto-active'
      } else if (enabledMatch) {
        configStatus = 'enabled'
        effectiveStatus = 'enabled'
      } else {
        configStatus = 'not-enabled'
        effectiveStatus = 'inactive'
      }

      return {
        key,
        name: manifest.name,
        kind: manifest.kind,
        source: manifest.source,
        configStatus,
        effectiveStatus,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        path: manifest.path,
        providesTools: manifest.providesTools,
        providesHooks: manifest.providesHooks,
        requiresEnv: manifest.requiresEnv,
      }
    })

  return {
    plugins,
    warnings,
    metadata: {
      hermesAgentRoot: agentRoot,
      pythonExecutable: command.command,
      cwd: process.cwd(),
      projectPluginsEnabled,
    },
  }
}

function configPathForProfile(profile?: string): string {
  return join(profile ? getProfileDir(profile) : getActiveProfileDir(), 'config.yaml')
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).map(value => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function isManageablePlugin(plugin: HermesPluginInfo): boolean {
  return plugin.kind === 'standalone' && plugin.source !== 'bundled'
}

function pluginAliases(plugin: HermesPluginInfo, requestedKey: string): string[] {
  return uniqueSorted([requestedKey, plugin.key, plugin.name])
}

export async function setHermesPluginEnabled(profile: string | undefined, key: string, enabled: boolean): Promise<HermesPluginMutationResult> {
  const pluginKey = String(key || '').trim()
  if (!pluginKey) throw new Error('Plugin key is required')

  const inventory = await listHermesPlugins(profile)
  const plugin = inventory.plugins.find(item => item.key === pluginKey || item.name === pluginKey)
  if (!plugin) throw new Error(`Plugin not found: ${pluginKey}`)
  if (!isManageablePlugin(plugin)) {
    throw new Error(`Plugin cannot be managed from Studio: ${plugin.key}`)
  }

  const aliases = pluginAliases(plugin, pluginKey)
  await safeFileStore.updateYaml(configPathForProfile(profile), (config) => {
    const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? config.plugins
      : {}
    const currentEnabled: string[] = Array.isArray(plugins.enabled) ? plugins.enabled.map(String) : []
    const currentDisabled: string[] = Array.isArray(plugins.disabled) ? plugins.disabled.map(String) : []
    const aliasSet = new Set(aliases)

    if (enabled) {
      plugins.enabled = uniqueSorted([...currentEnabled.filter(value => !aliasSet.has(value)), plugin.key])
      plugins.disabled = uniqueSorted(currentDisabled.filter(value => !aliasSet.has(value)))
    } else {
      plugins.enabled = uniqueSorted(currentEnabled.filter(value => !aliasSet.has(value)))
      plugins.disabled = uniqueSorted([...currentDisabled.filter(value => !aliasSet.has(value)), plugin.key])
    }

    config.plugins = plugins
    return config
  }, {
    backup: true,
    dumpOptions: {
      forceQuotes: true,
    },
  })

  return { key: plugin.key, enabled }
}
