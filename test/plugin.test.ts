import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import createPlugin from '../src/index.js'
import { sentValue, type HandleMessage } from './helpers.js'

const SELF = 'urn:mrn:imo:mmsi:111111111'
const OTHER = 'urn:mrn:imo:mmsi:222222222'

function nav(lat: number, cogDeg: number, sog: number) {
  const timestamp = new Date().toISOString()
  return {
    position: { value: { latitude: lat, longitude: 1 }, timestamp },
    courseOverGroundTrue: { value: (cogDeg * Math.PI) / 180, timestamp },
    speedOverGround: { value: sog, timestamp }
  }
}

function fakeApp(managed: boolean) {
  const notifications = {
    getId: vi.fn(() => {
      if (!managed) throw new Error('disabled')
      return undefined
    }),
    raise: vi.fn(() => 'n1'),
    update: vi.fn(),
    clear: vi.fn()
  }
  const app = {
    selfId: SELF,
    notifications,
    debug: vi.fn(),
    setPluginStatus: vi.fn(),
    handleMessage: vi.fn<HandleMessage>(),
    getSelfPath: vi.fn(() => nav(50, 0, 5)),
    getPath: vi.fn((path: string): unknown =>
      path === 'vessels'
        ? {
            [SELF]: { navigation: nav(50, 0, 5) },
            [OTHER]: { navigation: nav(50 + 1 / 60, 180, 5) }
          }
        : undefined
    )
  }
  return { app: app as unknown as ServerAPI, notifications, handleMessage: app.handleMessage }
}

describe('plugin', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    globalThis.__signalk_collisionAlerts = undefined
  })

  it('starts with an empty config and raises through the Notifications API', async () => {
    const { app, notifications, handleMessage } = fakeApp(true)
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    expect(handleMessage).toHaveBeenCalledWith(
      'collision-alerts',
      expect.objectContaining({ context: `vessels.${OTHER}` })
    )
    await plugin.stop()
    expect(notifications.clear).toHaveBeenCalledWith('n1')
    expect(sentValue(handleMessage, -1)).toEqual({
      path: 'navigation.closestApproach',
      value: null
    })
  })

  it('falls back to notification deltas when the server does not manage notifications', async () => {
    const { app, notifications, handleMessage } = fakeApp(false)
    const plugin = createPlugin(app)
    plugin.start({ publishClosestApproach: false }, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).not.toHaveBeenCalled()
    expect(sentValue(handleMessage, 0).path).toBe(
      `notifications.navigation.closestApproach.${OTHER}`
    )
    await plugin.stop()
  })

  it('tells other plugins it is running until it stops', async () => {
    const { app } = fakeApp(true)
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    expect(globalThis.__signalk_collisionAlerts).toEqual({ evaluatesTargets: true })
    await plugin.stop()
    expect(globalThis.__signalk_collisionAlerts).toBeUndefined()
  })
})

describe('plugin with sensor targets', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('evaluates targets.* alongside the vessels', async () => {
    const { app, notifications } = fakeApp(true)
    const vessels = app.getPath('vessels')
    app.getPath = vi.fn((path: string): unknown =>
      path === 'targets' ? { 'radar:radar-0-17': { navigation: nav(50 - 1 / 60, 0, 10) } } : vessels
    )
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledTimes(2)
    await plugin.stop()
  })
})

describe('config schema', () => {
  it('declares the same defaults the plugin applies at runtime', async () => {
    const { ConfigSchema, DEFAULTS } = await import('../src/config.js')
    // The admin UI receives the schema as plain JSON, so compare it in that form.
    const properties = JSON.parse(JSON.stringify(ConfigSchema.properties)) as Partial<
      Record<string, { default?: unknown }>
    >
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(properties[key]?.default).toEqual(value)
    }
  })
})
