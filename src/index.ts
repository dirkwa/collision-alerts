import type { Context, Delta, Path, Plugin, ServerAPI } from '@signalk/server-api'
import { DeltaAlarmSink, ManagedAlarmSink, type AlarmSink } from './alarms.js'
import { Evaluator, OwnShip, type Evaluation, type VesselNode } from './evaluator.js'
import { ConfigSchema, DEFAULTS, type Config } from './config.js'
import { PRESETS, type Zone } from './zones.js'
import { targetNodes, type SensorTargetNode } from './targets.js'

const PLUGIN_ID = 'collision-alerts'
const NM = 1852
const KNOT = 1852 / 3600

// Sensor plugins that raise collision alarms of their own (mayara for radar
// targets) stand down while this property says so, so a target alarms once.
const COLLISION_ALERTS_PROPERTY = 'collisionAlerts'
interface CollisionAlertsProperty {
  evaluatesTargets: boolean
}

function zonesFor(config: Config): Zone[] {
  return config.preset === 'custom' ? config.customZones : PRESETS[config.preset]
}

function createSink(app: ServerAPI): AlarmSink {
  try {
    // getId throws NotificationManagerDisabledError when the server leaves
    // notifications unmanaged; ack/silence then don't exist, so fall back.
    app.notifications.getId('probe' as Parameters<ServerAPI['notifications']['getId']>[0])
    return new ManagedAlarmSink(app)
  } catch {
    app.debug('Notification management unavailable, publishing notification deltas')
    return new DeltaAlarmSink(app, PLUGIN_ID)
  }
}

export default function (app: ServerAPI): Plugin {
  let timer: ReturnType<typeof setInterval> | undefined
  let evaluator: Evaluator | undefined
  // Contexts we published a closest approach on, so stop() can clear them.
  const published = new Set<string>()

  function publishClosestApproach(evaluations: Evaluation[]): void {
    // A target the server stopped reporting has no evaluation at all, so
    // clear what we published for it as if it had gone out of range.
    const current = new Set(evaluations.map((e) => e.context))
    const gone = [...published]
      .filter((context) => !current.has(context))
      .map((context) => ({ targetId: context, context, result: null }))
    for (const { context, result } of [...evaluations, ...gone]) {
      if (!result && !published.has(context)) {
        continue
      }
      const value = result ? { distance: result.cpa, timeTo: result.tcpa } : null
      if (result) {
        published.add(context)
      } else {
        published.delete(context)
      }
      const delta: Delta = {
        context: context as Context,
        updates: [{ values: [{ path: 'navigation.closestApproach' as Path, value }] }]
      }
      app.handleMessage(PLUGIN_ID, delta)
    }
  }

  // PropertyValues keep every emitted value, so emit on changes only.
  let evaluatesTargets = false
  function announce(running: boolean): void {
    if (running === evaluatesTargets) {
      return
    }
    const value: CollisionAlertsProperty = { evaluatesTargets: running }
    try {
      app.emitPropertyValue(COLLISION_ALERTS_PROPERTY, value)
      evaluatesTargets = running
    } catch (err) {
      // The server caps PropertyValues across all plugins and throws past
      // the cap; sensor plugins then keep their own alarms, never fewer.
      app.error(`Could not announce collision alerts to other plugins: ${String(err)}`)
    }
  }

  return {
    id: PLUGIN_ID,
    name: 'Collision Alerts',
    description: 'CPA/TCPA collision alerts for AIS, radar and other targets',
    schema: () => ConfigSchema,

    start(partial: object) {
      // The server does not apply schema defaults at runtime.
      const config: Config = { ...DEFAULTS, ...(partial as Partial<Config>) }
      const maxAge = config.maxAge
      const activeEvaluator = new Evaluator(
        {
          zones: zonesFor(config),
          slowZones: PRESETS.harbour,
          slowSpeed: config.slowSpeed * KNOT,
          maxAlarms: config.maxAlarms,
          maxRange: config.maxRange * NM,
          maxAge
        },
        createSink(app)
      )
      evaluator = activeEvaluator
      const ownShip = new OwnShip()

      timer = setInterval(() => {
        // One bad target or data-model surprise must not stop the alarm loop.
        try {
          const now = Date.now()
          const ownNode = { navigation: app.getSelfPath('navigation') as VesselNode['navigation'] }
          // Own ship's drift is not measured: its GPS sees every swing at
          // anchor, which reads as steady drift towards the neighbours on
          // that side, while their AIS reports every few minutes rarely
          // shows the same swing. Dragging own anchor is the anchor alarm's.
          const own = ownShip.track(ownNode, now, maxAge)
          // Radar and camera targets linked to an AIS vessel fold into it, so
          // a boat seen on both raises one alarm rather than one per sensor.
          const vessels = targetNodes(
            (app.getPath('vessels') ?? {}) as Record<string, VesselNode>,
            app.getPath('targets') as Record<string, SensorTargetNode> | undefined,
            now
          )
          const evaluations = activeEvaluator.evaluate(own, vessels, app.selfId, now)
          if (config.publishClosestApproach) {
            publishClosestApproach(evaluations)
          }
        } catch (err) {
          app.error(`Collision evaluation failed: ${String(err)}`)
        }
      }, config.interval * 1000)
      announce(true)
      app.setPluginStatus('Watching AIS, radar and other targets')
    },

    stop() {
      clearInterval(timer)
      timer = undefined
      evaluator?.stop()
      evaluator = undefined
      publishClosestApproach([])
      announce(false)
    }
  }
}
