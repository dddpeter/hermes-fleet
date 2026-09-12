import { execFile, spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { homedir } from 'os'
import YAML from 'js-yaml'
import { logger } from '../logger'
import { getActiveProfileDir, getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from './hermes-profile'
import { startGatewayRunManaged } from './gateway-runner'
import { isGatewayRunningForProfile, isGatewayRunningForProfileDir } from './gateway-autostart'
import { execHermesWithBin, spawnHermesWithBin } from './hermes-process'

const execFileAsync = promisify(execFile)

const execOpts = { windowsHide: true }
const isTermux = !!process.env.TERMUX_VERSION ||
  (process.env.PREFIX || '').includes('/com.termux/') ||
  existsSync('/data/data/com.termux/files/usr')

/**
 * 解析 Hermes CLI 二进制路径
 * 优先使用环境变量 HERMES_BIN，否则使用 PATH 中的 'hermes' 命令
 */
function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

const HERMES_BIN = resolveHermesBin()

async function waitForGatewayRunning(profileDir: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isGatewayRunningForProfile(HERMES_BIN, profileDir)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function stopGatewayForActiveProfile(): Promise<void> {
  try {
    await execHermesWithBin(HERMES_BIN, ['gateway', 'stop'], {
      timeout: 30000,
      ...activeGatewayExecOpts(),
    })
  } catch (err) {
    logger.warn(err, 'hermes gateway stop before restart failed; continuing with run --replace')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function readJsonPid(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readGatewayLockPid(profileDir: string): number | null {
  return readJsonPid(join(profileDir, 'gateway.lock'))
}

function readGatewayStatePid(profileDir: string): number | null {
  const pid = readJsonPid(join(profileDir, 'gateway.pid'))
  if (pid) return pid
  const statePath = join(profileDir, 'gateway_state.json')
  if (!existsSync(statePath)) return null
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    const state = data?.gateway_state
    const statePid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return statePid && Number.isFinite(statePid) && statePid > 0 && (state === 'running' || state === 'starting')
      ? statePid
      : null
  } catch {
    return null
  }
}

async function killWindowsPid(pid: number): Promise<void> {
  if (!pid || process.platform !== 'win32') return
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: 5000,
      windowsHide: true,
    })
  } catch (err) {
    logger.warn(err, 'Failed to taskkill gateway PID %d; falling back to process.kill', pid)
    try { process.kill(pid) } catch {}
  }
}

function cleanupStaleGatewayLock(profileDir: string, allowMalformedDelete = false): boolean {
  const lockPath = join(profileDir, 'gateway.lock')
  if (!existsSync(lockPath)) return true
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'))
    const pid = Number(lockData?.pid)
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) return false
    unlinkSync(lockPath)
    return true
  } catch {
    if (!allowMalformedDelete) return false
    try {
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
}

async function waitForGatewayLockReleased(profileDir: string, timeoutMs = 15000, allowMalformedDelete = false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cleanupStaleGatewayLock(profileDir, allowMalformedDelete)) return true
    await sleep(500)
  }
  return cleanupStaleGatewayLock(profileDir, allowMalformedDelete)
}

async function forceReleaseWindowsGatewayLock(profileDir: string): Promise<void> {
  if (process.platform !== 'win32') return
  const pids = new Set<number>()
  const lockPid = readGatewayLockPid(profileDir)
  const statePid = readGatewayStatePid(profileDir)
  if (lockPid) pids.add(lockPid)
  if (statePid) pids.add(statePid)

  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      logger.warn('Gateway lock is still held by PID %d; force killing Windows process tree', pid)
      await killWindowsPid(pid)
    }
  }
}

async function waitForGatewayLockReleasedAfterStop(profileDir: string, timeoutMs = 15000): Promise<boolean> {
  if (await waitForGatewayLockReleased(profileDir, timeoutMs)) return true
  await forceReleaseWindowsGatewayLock(profileDir)
  return waitForGatewayLockReleased(profileDir, 5000, true)
}

function activeGatewayExecOpts() {
  return {
    ...execOpts,
    env: {
      ...process.env,
      HERMES_HOME: getActiveProfileDir(),
    },
  }
}

export interface HermesSession {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  messages?: any[]
}

export interface HermesSessionFull {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd?: number | null
  cost_status?: string
  messages?: any[]
  system_prompt?: string
  model_config?: string
  cost_source?: string
  pricing_version?: string | null
  [key: string]: any
}

function parseSessionExport(stdout: string): HermesSessionFull[] {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const sessions: HermesSessionFull[] = []
  for (const line of lines) {
    try {
      const raw: HermesSessionFull = JSON.parse(line)
      sessions.push(raw)
    } catch {
      // No longer silent: an unparseable line (CLI banner, localized error,
      // format change) must be observable or a format change goes unnoticed.
      logger.warn({ line: line.slice(0, 200) }, 'Hermes CLI: sessions export produced a non-JSON line; skipped')
    }
  }
  return sessions
}

export async function exportSessionsRaw(source?: string): Promise<HermesSessionFull[]> {
  const args = ['sessions', 'export', '-']
  if (source) args.push('--source', source)

  try {
    const { stdout } = await execHermesWithBin(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 30000,
      ...execOpts,
    })
    return parseSessionExport(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: sessions export failed')
    throw new Error(`Failed to list sessions: ${err.message}`)
  }
}

/**
 * List sessions from Hermes CLI (without messages)
 */
export async function listSessions(source?: string, limit?: number): Promise<HermesSession[]> {
  const raws = await exportSessionsRaw(source)
  const sessions: HermesSession[] = []

  for (const raw of raws) {
    let title = raw.title
    if (!title && raw.messages) {
      const firstUser = raw.messages.find((m: any) => m.role === 'user')
      if (firstUser?.content) {
        const t = String(firstUser.content).slice(0, 40)
        title = t + (String(firstUser.content).length > 40 ? '...' : '')
      }
    }
    sessions.push({
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
    })
  }

  // Sort by started_at descending
  sessions.sort((a, b) => b.started_at - a.started_at)

  if (limit && limit > 0) {
    return sessions.slice(0, limit)
  }
  return sessions
}

/**
 * Get a single session with messages from Hermes CLI
 */
export async function getSession(id: string): Promise<HermesSession | null> {
  const args = ['sessions', 'export', '-', '--session-id', id]

  try {
    const { stdout } = await execHermesWithBin(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })

    const raws = parseSessionExport(stdout)
    if (raws.length === 0) return null

    const raw: HermesSessionFull = raws[0]
    return {
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title: raw.title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
      messages: raw.messages,
    }
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: session export failed')
    throw new Error(`Failed to get session: ${err.message}`)
  }
}

/**
 * Delete a session from Hermes CLI
 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await execHermesWithBin(HERMES_BIN, ['sessions', 'delete', id, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session delete failed')
    return false
  }
}

/**
 * Delete a session from a specific Hermes profile.
 */
export async function deleteSessionForProfile(id: string, profile: string): Promise<boolean> {
  try {
    await execHermesWithBin(HERMES_BIN, ['sessions', 'delete', id, '--yes'], {
      timeout: 10000,
      ...execOpts,
      env: {
        ...process.env,
        HERMES_HOME: getProfileDir(profile),
      },
    })
    return true
  } catch (err: any) {
    logger.error({ err, sessionId: id, profile }, 'Hermes CLI: profile session delete failed')
    return false
  }
}

/**
 * Rename a session title via Hermes CLI
 */
export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await execHermesWithBin(HERMES_BIN, ['sessions', 'rename', id, title], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session rename failed')
    return false
  }
}

export interface LogFileInfo {
  name: string
  size: string
  modified: string
}

/**
 * Get Hermes version
 */
const HERMES_AGENT_VERSION_TTL_MS = 5 * 60 * 1000
let cachedHermesAgentVersion: { value: string; at: number } | null = null

export async function getVersion(): Promise<string> {
  if (cachedHermesAgentVersion && Date.now() - cachedHermesAgentVersion.at < HERMES_AGENT_VERSION_TTL_MS) {
    return cachedHermesAgentVersion.value
  }
  try {
    const { stdout } = await execHermesWithBin(HERMES_BIN, ['--version'], { timeout: 5000, ...execOpts })
    const value = stdout.trim()
    cachedHermesAgentVersion = { value, at: Date.now() }
    return value
  } catch {
    return ''
  }
}

/**
 * Start Hermes gateway (uses launchd/systemd)
 */
export async function startGateway(): Promise<string> {
  const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['gateway', 'start'], {
    timeout: 30000,
    ...activeGatewayExecOpts(),
  })
  return stdout || stderr
}

/**
 * Start Hermes gateway in background (for WSL where launchd/systemd is unavailable)
 * Uses "hermes gateway run" as a detached background process
 */
export async function startGatewayBackground(): Promise<number | null> {
  const child = spawnHermesWithBin(HERMES_BIN, ['gateway', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: getActiveProfileDir(),
    },
  })
  child.unref()
  return child.pid ?? null
}

/**
 * Restart Hermes gateway through Hermes CLI, falling back to detached
 * `gateway run` when the environment does not support `gateway restart`.
 */
export async function restartGateway(): Promise<string> {
  const profileDir = getActiveProfileDir()
  if (isTermux || process.platform === 'win32') {
    await stopGatewayForActiveProfile()
    const lockReleased = await waitForGatewayLockReleasedAfterStop(profileDir)
    if (!lockReleased) throw new Error('Gateway stopped but runtime lock is still held by another process')
    const result = startGatewayRunManaged(HERMES_BIN, { profileDir })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error(`Gateway run replace triggered but gateway did not report running within timeout${result.pid ? ` (PID: ${result.pid})` : ''}`)
    return result.pid ? `Gateway run replaced (PID: ${result.pid})` : 'Gateway run replaced'
  }
  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['gateway', 'restart'], {
      timeout: 30000,
      ...activeGatewayExecOpts(),
    })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error('Hermes gateway restart completed but gateway did not report running within timeout')
    return stdout || stderr
  } catch (err: any) {
    logger.warn(err, 'hermes gateway restart failed; falling back to gateway run')
    await stopGatewayForActiveProfile()
    const lockReleased = await waitForGatewayLockReleasedAfterStop(profileDir)
    if (!lockReleased) throw new Error('Gateway restart failed and runtime lock is still held by another process')
    const result = startGatewayRunManaged(HERMES_BIN, { profileDir })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error(`Gateway run fallback triggered but gateway did not report running within timeout${result.pid ? ` (PID: ${result.pid})` : ''}`)
    return result.pid ? `Gateway run started (PID: ${result.pid})` : 'Gateway run started'
  }
}

/**
 * Stop Hermes gateway
 */
export async function stopGateway(): Promise<string> {
  const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['gateway', 'stop'], {
    timeout: 30000,
    ...activeGatewayExecOpts(),
  })
  return stdout || stderr
}

/**
 * List available log files.
 *
 * Log files live at `<HERMES_HOME>/logs/*.log` (agent.log, errors.log,
 * gateway.log, gui.log, …) — enumerate the directory directly instead of
 * parsing `hermes logs list` output, which was both localized-text fragile
 * and hard-coded to a fixed log-name whitelist.
 */
export async function listLogFiles(): Promise<LogFileInfo[]> {
  const logsDir = join(getActiveProfileDir(), 'logs')
  if (!existsSync(logsDir)) return []
  let entries
  try {
    entries = readdirSync(logsDir, { withFileTypes: true })
  } catch (err) {
    logger.warn(err, 'Hermes CLI: failed to read logs directory %s', logsDir)
    return []
  }

  const files: LogFileInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    // Rotated backups (agent.log.1, agent.log.2.gz, …) never end in `.log`;
    // the UI reads live logs by name via `hermes logs <name>`.
    try {
      const stat = statSync(join(logsDir, entry.name))
      files.push({
        name: entry.name.replace(/\.log$/, ''),
        size: formatLogSize(stat.size),
        modified: stat.mtime.toISOString(),
      })
    } catch (err) {
      logger.warn(err, 'Hermes CLI: failed to stat log file %s', entry.name)
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const next of units) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}${unit}`
}

/**
 * Read log lines
 */
export async function readLogs(
  logName: string = 'agent',
  lines: number = 100,
  level?: string,
  session?: string,
  since?: string,
): Promise<string> {
  const args = ['logs', logName, '-n', String(lines)]
  if (level) args.push('--level', level)
  if (session) args.push('--session', session)
  if (since) args.push('--since', since)

  try {
    const { stdout } = await execHermesWithBin(HERMES_BIN, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
      ...execOpts,
    })
    return stdout
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: logs read failed')
    throw new Error(`Failed to read logs: ${err.message}`)
  }
}

// ─── Profile management ──────────────────────────────────────

export interface HermesProfile {
  name: string
  active: boolean
  model: string
  gatewayStatus?: string
  alias: string
}

export interface HermesProfileDetail {
  name: string
  path: string
  model: string
  provider: string
  skills: number
  hasEnv: boolean
  hasSoulMd: boolean
}

function readProfileModelAndProvider(profileDir: string): { model: string; provider: string } {
  const configPath = join(profileDir, 'config.yaml')
  if (!existsSync(configPath)) return { model: '—', provider: '' }
  try {
    const config = YAML.load(readFileSync(configPath, 'utf-8'), { json: true }) as Record<string, any> | null
    const model = config?.model
    if (typeof model === 'string') return { model: model.trim() || '—', provider: '' }
    if (model && typeof model === 'object') {
      return {
        model: String(model.default || model.model || '').trim() || '—',
        provider: String(model.provider || '').trim(),
      }
    }
  } catch (err) {
    logger.warn(err, 'Hermes CLI: failed to read profile config model for %s', profileDir)
  }
  return { model: '—', provider: '' }
}

// Mirrors hermes-agent's ProfileInfo (hermes_cli/profiles.py): profile facts
// are derived from the profile directory itself instead of parsing
// `hermes profile list/show` stdout.
const EXCLUDED_SKILL_DIRS = new Set([
  '.git', '.github', '.hub', '.archive', '.curator_backups',
  '.venv', 'venv', 'node_modules', 'site-packages', '__pycache__',
  '.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
])
const SKILL_SUPPORT_DIRS = new Set(['references', 'templates', 'assets', 'scripts'])

function countProfileSkills(profileDir: string): number {
  const skillsDir = join(profileDir, 'skills')
  if (!existsSync(skillsDir)) return 0
  const skillRootDirs = new Set<string>()
  const stack: string[] = [skillsDir]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    const hasOwnSkillMd = entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')
    if (hasOwnSkillMd) {
      count += 1
      skillRootDirs.add(current)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue
      // Support dirs (references/templates/assets/scripts) directly inside a
      // skill package are loaded explicitly, never scanned as skills.
      if (SKILL_SUPPORT_DIRS.has(entry.name) && skillRootDirs.has(current)) continue
      stack.push(join(current, entry.name))
    }
  }
  return count
}

function readProfileAliasMap(): Map<string, string> {
  // Hermes wrapper scripts live in ~/.local/bin (`<alias>` on POSIX,
  // `<alias>.bat` on Windows) and contain `hermes -p <profile>`.
  const wrapperDir = join(homedir(), '.local', 'bin')
  const result = new Map<string, string>()
  let entries
  try {
    entries = readdirSync(wrapperDir, { withFileTypes: true })
  } catch {
    return result
  }
  const isWindows = process.platform === 'win32'
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue
    if (isWindows) {
      if (!entry.name.toLowerCase().endsWith('.bat')) continue
    } else if (entry.name.includes('.')) {
      continue
    }
    let content: string
    try {
      const stat = statSync(join(wrapperDir, entry.name))
      if (stat.size > 8192) continue
      content = readFileSync(join(wrapperDir, entry.name), 'utf-8')
    } catch {
      continue
    }
    const marker = 'hermes -p '
    const idx = content.indexOf(marker)
    if (idx === -1) continue
    const canon = content.slice(idx + marker.length).trim().split(/\s+/)[0]
    if (!canon) continue
    const alias = isWindows ? entry.name.slice(0, -4) : entry.name
    if (alias === canon) {
      if (!result.has(canon)) result.set(canon, alias)
    } else {
      result.set(canon, alias)
    }
  }
  return result
}

/**
 * List all profiles
 */
export async function listProfiles(): Promise<HermesProfile[]> {
  const profileNames = listProfileNamesFromDisk()
  const activeProfileName = getActiveProfileName()
  const aliasMap = readProfileAliasMap()

  return Promise.all(profileNames.map(async name => {
    const profileDir = getProfileDir(name)
    const { model } = readProfileModelAndProvider(profileDir)
    const running = await isGatewayRunningForProfileDir(profileDir)
    return {
      name,
      active: name === activeProfileName,
      model,
      gatewayStatus: running ? 'running' : 'stopped',
      alias: name === 'default' ? '' : (aliasMap.get(name) || ''),
    }
  }))
}

/**
 * Get profile details
 */
export async function getProfile(name: string): Promise<HermesProfileDetail> {
  const profileDir = getProfileDir(name)
  if (!existsSync(profileDir)) {
    throw new Error(`Profile "${name}" not found`)
  }

  const { model, provider } = readProfileModelAndProvider(profileDir)

  return {
    name,
    path: profileDir,
    model,
    provider,
    skills: countProfileSkills(profileDir),
    hasEnv: existsSync(join(profileDir, '.env')),
    hasSoulMd: existsSync(join(profileDir, 'SOUL.md')),
  }
}

/**
 * Create a new profile
 */
export async function createProfile(name: string, clone?: boolean): Promise<string> {
  const args = ['profile', 'create', name]
  if (clone) args.push('--clone')

  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, args, {
      timeout: 15000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile create failed')
    throw new Error(`Failed to create profile: ${err.message}`)
  }
}

/**
 * Delete a profile
 */
export async function deleteProfile(name: string): Promise<boolean> {
  try {
    await execHermesWithBin(HERMES_BIN, ['profile', 'delete', name, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile delete failed')
    return false
  }
}

/**
 * Rename a profile
 */
export async function renameProfile(oldName: string, newName: string): Promise<boolean> {
  try {
    await execHermesWithBin(HERMES_BIN, ['profile', 'rename', oldName, newName], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile rename failed')
    return false
  }
}

/**
 * Switch active profile
 */
export async function useProfile(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['profile', 'use', name], {
      timeout: 10000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile use failed')
    throw new Error(`Failed to switch profile: ${err.message}`)
  }
}

/**
 * Export profile to archive
 */
export async function exportProfile(name: string, outputPath?: string): Promise<string> {
  const args = ['profile', 'export', name]
  if (outputPath) args.push('--output', outputPath)

  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, args, {
      timeout: 60000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile export failed')
    throw new Error(`Failed to export profile: ${err.message}`)
  }
}

/**
 * Run hermes setup --non-interactive --reset to generate default config for current profile
 */
export async function setupReset(): Promise<string> {
  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['setup', '--non-interactive', '--reset'], {
      timeout: 30000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: setup reset failed')
    throw new Error(`Failed to reset config: ${err.message}`)
  }
}

/**
 * Import profile from archive
 */
export async function importProfile(archivePath: string, name?: string): Promise<string> {
  const args = ['profile', 'import', archivePath]
  if (name) args.push('--name', name)

  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, args, {
      timeout: 60000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile import failed')
    throw new Error(`Failed to import profile: ${err.message}`)
  }
}

/**
 * Pin or unpin a skill via hermes curator
 */
export async function pinSkill(name: string, pinned: boolean): Promise<string> {
  const subcmd = pinned ? 'pin' : 'unpin'
  try {
    const { stdout, stderr } = await execHermesWithBin(HERMES_BIN, ['curator', subcmd, name], {
      timeout: 15000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, `Hermes CLI: curator ${subcmd} failed`)
    throw new Error(`Failed to ${subcmd} skill: ${err.message}`)
  }
}
