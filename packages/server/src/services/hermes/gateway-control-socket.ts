import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { connect } from 'net'
import { join, resolve } from 'path'

// Client for the Hermes gateway control socket — the gateway-owned local
// coordination surface answering versioned JSON verbs (`identify`, `status`).
// One JSON request line in, one JSON response line out; a connectable socket
// with a well-formed `identify` answer IS liveness (see
// hermes-agent `gateway/control_socket.py`, CONTROL_PROTOCOL_VERSION 1).
// POSIX: `$HERMES_HOME/gateway.sock` (or the path in `gateway.sock.path` when
// the home exceeds sun_path). Windows: named pipe `\\.\pipe\hermes-gateway-<hash>`.

export const GATEWAY_CONTROL_PROTOCOL_VERSION = 1

function homeHash(home: string): string {
  // Mirrors os.path.normcase + Path.resolve on the gateway side so both sides
  // derive the same pipe name from the same HERMES_HOME.
  let normalized = resolve(home)
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//g, '\\').toLowerCase()
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

export function windowsGatewayControlPipeName(home: string): string {
  return `\\\\.\\pipe\\hermes-gateway-${homeHash(home)}`
}

export function resolveGatewayControlSocketPath(home: string): string | null {
  const direct = join(home, 'gateway.sock')
  if (existsSync(direct)) return direct
  const pointerPath = join(home, 'gateway.sock.path')
  if (existsSync(pointerPath)) {
    try {
      const target = readFileSync(pointerPath, 'utf8').trim()
      if (target && existsSync(target)) return target
    } catch {
      // Unreadable pointer: fall through to "no socket".
    }
  }
  return null
}

async function requestGatewayControl(
  home: string,
  verb: 'identify' | 'status',
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  let endpoint: string
  if (process.platform === 'win32') {
    endpoint = windowsGatewayControlPipeName(home)
  } else {
    const socketPath = resolveGatewayControlSocketPath(home)
    if (!socketPath) return null
    endpoint = socketPath
  }

  return await new Promise((resolvePromise) => {
    let settled = false
    let buffer = ''
    const socket = connect(endpoint)
    const finish = (result: Record<string, unknown> | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ verb })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const parsed = JSON.parse(buffer.slice(0, newline))
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}

export async function isGatewayAliveViaControlSocket(home: string, timeoutMs?: number): Promise<boolean> {
  const response = await requestGatewayControl(home, 'identify', timeoutMs)
  if (!response) return false
  if (response.ok !== true) return false
  const protocol = typeof response.protocol === 'number' ? response.protocol : GATEWAY_CONTROL_PROTOCOL_VERSION
  return protocol === GATEWAY_CONTROL_PROTOCOL_VERSION && response.result !== null && typeof response.result === 'object'
}
