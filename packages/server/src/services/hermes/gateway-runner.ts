import { execFile } from 'child_process'
import { openSync, mkdirSync, closeSync } from 'fs'
import { basename } from 'path'
import { promisify } from 'util'
import { getWebUiHome } from '../../config'
import { logger } from '../logger'
import { getActiveProfileDir, getHermesBaseDir } from './hermes-profile'
import { spawnHermesWithBin } from './hermes-process'

interface SupervisedGateway {
  pid: number
  child: ReturnType<typeof spawnHermesWithBin>
  hermesBin: string
  profileDir: string
  startedAt: number
  assignedPort: number
  logPath: string | null
}

/**
 * Per-profile state for our supervised gateway.
 *
 * - `current` is the most recent child we spawned for this profile. When it
 *   exits, the exit handler clears this slot.
 * - `respawnTimer` is a pending respawn that was scheduled because the
 *   previous child died and no replacement has been started yet. The next
 *   call to `startGatewayRunManaged` for the same profile clears it: a fresh
 *   start is already happening, so a respawn would race with it.
 *
 * This is what makes `/restart` safe. The flow is:
 *   1. `/restart` calls `hermes gateway stop` (CLI) which kills our child.
 *   2. That child's exit handler schedules a respawn timer (step T+0).
 *   3. `/restart` then calls `startGatewayRunManaged` for the same profile.
 *   4. That call clears the pending respawn timer (we're starting a new one
 *      anyway) and registers the fresh child.
 *
 * Net result: exactly one new gateway per `/restart`, no orphans.
 */
interface ProfileState {
  current: SupervisedGateway | null
  respawnTimer: NodeJS.Timeout | null
  respawnAttempts: number
}

const profileState = new Map<string, ProfileState>()

/** Delay before respawning a gateway that exited unexpectedly. */
const RESPAWN_DELAY_MS = 2000
const RESPAWN_STABLE_RUN_MS = 30000
const MAX_RESPAWN_ATTEMPTS = 3
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000
const DEFAULT_GATEWAY_PORT_BASE = 8642
const PORT_OFFSET_RANGE = 1000
const execFileAsync = promisify(execFile)

/**
 * Derive a stable profile name from a profile directory.
 *
 * `default` lives at the Hermes root (no trailing segment), so it can't be
 * obtained via `basename`. Anything else is `<root>/profiles/<name>/`.
 */
function profileNameFromDir(profileDir: string): string {
  const root = getHermesBaseDir()
  if (profileDir === root) return 'default'
  const name = basename(profileDir)
  return name || 'default'
}

/**
 * Deterministic, stable hash for a string (FNV-1a 32-bit). Used only to spread
 * profiles across a small port range, not for any security purpose.
 */
function stableHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Assign a distinct gateway port for a profile.
 *
 * The default profile keeps the base port. Every other profile gets the base
 * plus a deterministic offset derived from its name, so the same profile maps
 * to the same port across restarts (and two different profiles never collide
 * within the offset range).
 */
export function assignedGatewayPortForProfile(
  profileDir: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const base = parseInt(env.HERMES_WEB_UI_GATEWAY_PORT_BASE || '', 10) || DEFAULT_GATEWAY_PORT_BASE
  const name = profileNameFromDir(profileDir)
  if (name === 'default') return base
  return base + 1 + (stableHash(name) % (PORT_OFFSET_RANGE - 1))
}

/**
 * Assign the api_server platform port for a profile.
 *
 * The Hermes gateway reads this from `platforms.api_server.extra.port`
 * (default 8642). The default profile keeps the upstream default; every other
 * profile gets a deterministic offset above the base so multiple native
 * gateways can each bind their own api_server port.
 */
export function assignedApiServerPortForProfile(
  profileDir: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const base = parseInt(env.HERMES_WEB_UI_GATEWAY_PORT_BASE || '', 10) || DEFAULT_GATEWAY_PORT_BASE
  const name = profileNameFromDir(profileDir)
  if (name === 'default') return base
  return base + (stableHash(name) % PORT_OFFSET_RANGE)
}

/**
 * Assign the webhook platform port for a profile.
 *
 * The Hermes gateway reads this from `platforms.webhook.extra.port`
 * (default 8644 = base + 2). The webhook port tracks the api_server port by a
 * fixed +2 offset, matching the upstream default relationship, so the two
 * ports for a given profile never collide and stay easy to reason about.
 */
export function assignedWebhookPortForProfile(
  profileDir: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const base = parseInt(env.HERMES_WEB_UI_GATEWAY_PORT_BASE || '', 10) || DEFAULT_GATEWAY_PORT_BASE
  const name = profileNameFromDir(profileDir)
  if (name === 'default') return base + 2
  return base + 2 + (stableHash(name) % PORT_OFFSET_RANGE)
}

/**
 * Resolve the log directory for managed gateway output. Override via
 * HERMES_WEB_UI_GATEWAY_LOG_DIR; otherwise under the Web UI home `logs/`.
 */
function resolveGatewayLogDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.HERMES_WEB_UI_GATEWAY_LOG_DIR?.trim()
  return override || `${getWebUiHome()}/logs`
}

/**
 * Resolve the per-profile gateway log file path without opening it. Used for
 * surfacing the log location in runtime status. Path is always returned even
 * if the file does not exist yet (it is created on first spawn).
 */
export function gatewayLogPathForProfile(
  profileDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const name = profileNameFromDir(profileDir)
  return `${resolveGatewayLogDir(env)}/gateway-${name}.log`
}

/**
 * Open (creating) an append-mode log file for a profile's gateway. Returns the
 * path and an open fd, or null if the file could not be created (in which case
 * the gateway falls back to discarded stdio, as before).
 */
function openGatewayLog(logDir: string, profileName: string): { fd: number; path: string } | null {
  try {
    mkdirSync(logDir, { recursive: true })
    const path = `${logDir}/gateway-${profileName}.log`
    const fd = openSync(path, 'a')
    return { fd, path }
  } catch (err) {
    logger.warn({ err }, '[gateway-runner] failed to open gateway log file profile=%s; gateway stdio will be discarded', profileName)
    return null
  }
}

export interface ManagedGatewayShutdownResult {
  signaled: number
  forced: number
  errors: number
}

function getOrCreateProfileState(profileDir: string): ProfileState {
  let state = profileState.get(profileDir)
  if (!state) {
    state = { current: null, respawnTimer: null, respawnAttempts: 0 }
    profileState.set(profileDir, state)
  }
  return state
}

type KillWindowsProcessTree = (pid: number) => Promise<void>

function clearRespawnTimer(state: ProfileState, profileDir: string): void {
  if (!state.respawnTimer) return
  clearTimeout(state.respawnTimer)
  state.respawnTimer = null
  logger.info('[gateway-runner] cancelled pending respawn profileDir=%s', profileDir)
}

async function taskkillWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
  })
}

async function stopManagedGateway(
  entry: SupervisedGateway,
  opts: {
    timeoutMs: number
    platform: NodeJS.Platform
    killWindowsProcessTree: KillWindowsProcessTree
  },
): Promise<{ forced: boolean; error?: unknown }> {
  if (opts.platform === 'win32') {
    try {
      await opts.killWindowsProcessTree(entry.pid)
      return { forced: true }
    } catch (err) {
      logger.warn(err, '[gateway-runner] taskkill failed for managed gateway pid=%s; falling back to child.kill', entry.pid)
      try {
        entry.child.kill('SIGKILL')
        return { forced: true, error: err }
      } catch (killErr) {
        return { forced: true, error: killErr }
      }
    }
  }

  return new Promise(resolve => {
    let settled = false
    let forced = false

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      entry.child.off('exit', onExit)
      resolve({ forced, error })
    }

    const onExit = () => finish()
    const timer = setTimeout(() => {
      forced = true
      try {
        entry.child.kill('SIGKILL')
      } catch (err) {
        finish(err)
        return
      }
      finish()
    }, opts.timeoutMs)

    entry.child.once('exit', onExit)

    try {
      const signaled = entry.child.kill('SIGTERM')
      if (!signaled) finish(new Error(`Failed to signal managed gateway pid=${entry.pid}`))
    } catch (err) {
      finish(err)
    }
  })
}

export async function shutdownManagedGateways(
  opts: {
    timeoutMs?: number
    platform?: NodeJS.Platform
    killWindowsProcessTree?: KillWindowsProcessTree
  } = {},
): Promise<ManagedGatewayShutdownResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const platform = opts.platform ?? process.platform
  const killWindowsProcessTree = opts.killWindowsProcessTree ?? taskkillWindowsProcessTree
  const stops: Promise<{ forced: boolean; error?: unknown }>[] = []
  let signaled = 0

  for (const [profileDir, state] of profileState) {
    clearRespawnTimer(state, profileDir)

    const entry = state.current
    if (!entry) {
      profileState.delete(profileDir)
      continue
    }

    state.current = null
    signaled += 1
    logger.info('[gateway-runner] stopping managed gateway profileDir=%s pid=%s', profileDir, entry.pid)
    stops.push(stopManagedGateway(entry, { timeoutMs, platform, killWindowsProcessTree }))
    profileState.delete(profileDir)
  }

  const results = await Promise.all(stops)
  const forced = results.filter(result => result.forced).length
  const errors = results.filter(result => result.error).length

  if (signaled > 0) {
    logger.info('[gateway-runner] managed gateway shutdown complete signaled=%s forced=%s errors=%s', signaled, forced, errors)
  }

  return { signaled, forced, errors }
}

export async function retireManagedGatewayForProfile(
  profileDir: string,
  opts: {
    timeoutMs?: number
    platform?: NodeJS.Platform
    killWindowsProcessTree?: KillWindowsProcessTree
  } = {},
): Promise<ManagedGatewayShutdownResult> {
  const state = profileState.get(profileDir)
  if (!state) return { signaled: 0, forced: 0, errors: 0 }

  clearRespawnTimer(state, profileDir)

  const entry = state.current
  state.current = null
  profileState.delete(profileDir)

  if (!entry) return { signaled: 0, forced: 0, errors: 0 }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const platform = opts.platform ?? process.platform
  const killWindowsProcessTree = opts.killWindowsProcessTree ?? taskkillWindowsProcessTree

  logger.info('[gateway-runner] retiring managed gateway profileDir=%s pid=%s', profileDir, entry.pid)
  const result = await stopManagedGateway(entry, { timeoutMs, platform, killWindowsProcessTree })
  const forced = result.forced ? 1 : 0
  const errors = result.error ? 1 : 0

  logger.info(
    '[gateway-runner] managed gateway retire complete profileDir=%s signaled=1 forced=%s errors=%s',
    profileDir,
    forced,
    errors,
  )

  return { signaled: 1, forced, errors }
}

export function startGatewayRunManaged(
  hermesBin: string,
  opts: { profileDir?: string } = {},
): { pid: number | null; reused: boolean } {
  return startGatewayRunManagedInternal(hermesBin, {
    profileDir: opts.profileDir,
    preserveRespawnAttempts: false,
  })
}

function startGatewayRunManagedInternal(
  hermesBin: string,
  opts: { profileDir?: string; preserveRespawnAttempts?: boolean } = {},
): { pid: number | null; reused: boolean } {
  const profileDir = opts.profileDir || getActiveProfileDir()
  const state = getOrCreateProfileState(profileDir)
  const profileName = profileNameFromDir(profileDir)

  // A new spawn for this profile cancels any pending respawn from a previous
  // unexpected exit. Without this, `/restart` (stop -> start) would race
  // against the respawn timer and end up with two gateways on the same port.
  clearRespawnTimer(state, profileDir)
  if (!opts.preserveRespawnAttempts) {
    state.respawnAttempts = 0
  }

  // Assign a stable per-profile port so multiple native gateways can coexist.
  // The Hermes CLI may read HERMES_GATEWAY_PORT / GATEWAY_PORT; if it does not,
  // the assignment is still recorded for operations and diagnostics.
  const assignedPort = assignedGatewayPortForProfile(profileDir)
  // The api_server and webhook platform adapters bind their own ports on top of
  // the generic gateway port. We assign per-profile values for both and inject
  // them two ways for robustness:
  //   - config.yaml `platforms.<name>.extra.port` (written at profile creation)
  //   - API_SERVER_PORT / WEBHOOK_PORT env here (the api_server adapter only
  //     reliably honors the env at `gateway run` runtime; see config.py bridge).
  // Both compute from the same helpers so env and yaml never disagree.
  const apiServerPort = assignedApiServerPortForProfile(profileDir)
  const webhookPort = assignedWebhookPortForProfile(profileDir)
  // Redirect gateway stdout/stderr to a per-profile log file so operators can
  // debug each profile independently (the Web UI does not read these; it talks
  // to the gateway via the agent bridge). Falls back to discarded stdio if the
  // log file cannot be opened.
  const logHandle = openGatewayLog(resolveGatewayLogDir(), profileName)
  const stdio: 'ignore' | Array<'ignore' | number> = logHandle
    ? ['ignore', logHandle.fd, logHandle.fd]
    : 'ignore'

  const child = spawnHermesWithBin(hermesBin, ['gateway', 'run', '--replace'], {
    detached: true,
    stdio,
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: profileDir,
      HERMES_GATEWAY_PORT: String(assignedPort),
      GATEWAY_PORT: String(assignedPort),
      // The api_server adapter only bridges API_SERVER_PORT into its config
      // when API_SERVER_ENABLED is truthy (gateway/config.py). The platform is
      // already enabled in the profile's config.yaml, so setting this to 1
      // matches intent and lets API_SERVER_PORT take effect. Webhook reads
      // WEBHOOK_PORT under the same gate (enabled by default in config.yaml).
      API_SERVER_ENABLED: '1',
      API_SERVER_PORT: String(apiServerPort),
      WEBHOOK_PORT: String(webhookPort),
    },
  })
  child.unref()

  const pid = child.pid ?? null
  if (pid) {
    const entry: SupervisedGateway = {
      pid,
      child,
      hermesBin,
      profileDir,
      startedAt: Date.now(),
      assignedPort,
      logPath: logHandle?.path ?? null,
    }
    state.current = entry
    logger.info(
      '[gateway-runner] gateway started (profileDir=%s pid=%s assignedPort=%s log=%s)',
      profileDir, pid, assignedPort, entry.logPath ?? 'discarded',
    )

    child.on('exit', (code, signal) => {
      // Only act if this is still the active child for the profile. A new
      // start for the same profile replaces `state.current` and we don't
      // want the old child's exit to trigger anything.
      if (state.current?.pid !== pid) return
      state.current = null
      // Release the inherited log fd now that this child is gone; the file
      // itself persists for later inspection.
      if (logHandle) {
        try { closeSync(logHandle.fd) } catch { /* already closed */ }
      }
      if (Date.now() - entry.startedAt >= RESPAWN_STABLE_RUN_MS) {
        state.respawnAttempts = 0
      }
      state.respawnAttempts += 1

      if (state.respawnAttempts > MAX_RESPAWN_ATTEMPTS) {
        logger.error(
          '[gateway-runner] gateway exited unexpectedly and reached respawn limit (profileDir=%s pid=%s code=%s signal=%s attempts=%s maxAttempts=%s)',
          profileDir, pid, code, signal, state.respawnAttempts - 1, MAX_RESPAWN_ATTEMPTS,
        )
        return
      }

      logger.warn(
        '[gateway-runner] gateway exited unexpectedly (profileDir=%s pid=%s code=%s signal=%s attempt=%s/%s), respawning in %dms',
        profileDir, pid, code, signal, state.respawnAttempts, MAX_RESPAWN_ATTEMPTS, RESPAWN_DELAY_MS,
      )

      state.respawnTimer = setTimeout(() => {
        state.respawnTimer = null
        try {
          const next = startGatewayRunManagedInternal(hermesBin, {
            profileDir,
            preserveRespawnAttempts: true,
          })
          logger.info(
            '[gateway-runner] gateway respawned (oldPid=%s newPid=%s profileDir=%s attempt=%s/%s)',
            pid, next.pid, profileDir, state.respawnAttempts, MAX_RESPAWN_ATTEMPTS,
          )
        } catch (err) {
          logger.error(err, '[gateway-runner] failed to respawn gateway after unexpected exit')
        }
      }, RESPAWN_DELAY_MS)
      // Don't keep the event loop alive just for a pending respawn.
      state.respawnTimer.unref()
    })
  }

  return { pid, reused: false }
}
