import { afterEach, describe, expect, it } from 'vitest'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('per-profile platform port assignment', () => {
  it('default profile keeps the upstream defaults (api_server 8642, webhook 8644)', async () => {
    const { assignedApiServerPortForProfile, assignedWebhookPortForProfile } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )
    // default lives at the Hermes root; profileNameFromDir detects it via the
    // root comparison, so the path literal here is just a stand-in.
    const rootHome = process.env.HERMES_HOME || `${process.env.HOME}/.hermes`
    expect(assignedApiServerPortForProfile(rootHome)).toBe(8642)
    expect(assignedWebhookPortForProfile(rootHome)).toBe(8644)
  })

  it('non-default profiles get distinct, deterministic ports within the base range', async () => {
    const { assignedApiServerPortForProfile, assignedWebhookPortForProfile } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )
    const coderApi = assignedApiServerPortForProfile('/tmp/fake/profiles/coder')
    const coderWebhook = assignedWebhookPortForProfile('/tmp/fake/profiles/coder')

    // Within the documented range [base, base+1000)
    expect(coderApi).toBeGreaterThanOrEqual(8642)
    expect(coderApi).toBeLessThan(8642 + 1000)
    expect(coderWebhook).toBeGreaterThanOrEqual(8642 + 2)
    expect(coderWebhook).toBeLessThan(8642 + 2 + 1000)
    // webhook tracks api_server by a fixed +2 offset
    expect(coderWebhook - coderApi).toBe(2)
    // Never collides with the default ports
    expect(coderApi).not.toBe(8642)
    expect(coderWebhook).not.toBe(8644)
  })

  it('different profiles get different api_server ports', async () => {
    const { assignedApiServerPortForProfile } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )
    const coder = assignedApiServerPortForProfile('/tmp/fake/profiles/coder')
    const writer = assignedApiServerPortForProfile('/tmp/fake/profiles/writer')
    const reviewer = assignedApiServerPortForProfile('/tmp/fake/profiles/reviewer')
    expect(new Set([coder, writer, reviewer]).size).toBe(3)
  })

  it('is stable: the same profile dir always maps to the same ports', async () => {
    const { assignedApiServerPortForProfile, assignedWebhookPortForProfile } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )
    const dir = '/tmp/fake/profiles/coder'
    expect(assignedApiServerPortForProfile(dir)).toBe(assignedApiServerPortForProfile(dir))
    expect(assignedWebhookPortForProfile(dir)).toBe(assignedWebhookPortForProfile(dir))
  })

  it('respects HERMES_WEB_UI_GATEWAY_PORT_BASE for both platform ports', async () => {
    const { assignedApiServerPortForProfile, assignedWebhookPortForProfile } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )
    process.env.HERMES_WEB_UI_GATEWAY_PORT_BASE = '20000'
    expect(assignedApiServerPortForProfile('/tmp/fake/profiles/coder')).toBeGreaterThanOrEqual(20000)
    expect(assignedApiServerPortForProfile('/tmp/fake/profiles/coder')).toBeLessThan(21000)
    // webhook base shifts by +2 too
    expect(assignedWebhookPortForProfile('/tmp/fake/profiles/coder')).toBeGreaterThanOrEqual(20002)
    // default profile under the overridden base
    const rootHome = process.env.HERMES_HOME || `${process.env.HOME}/.hermes`
    expect(assignedApiServerPortForProfile(rootHome)).toBe(20000)
    expect(assignedWebhookPortForProfile(rootHome)).toBe(20002)
  })
})
