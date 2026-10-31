import { computeCpa, type CpaResult, type Track } from './cpa.js'
import type { AlarmSink, CollisionAlert } from './alarms.js'
import { DriftDetector } from './drift.js'
import { assess, SEVERITY, type AlertLevel, type Zone } from './zones.js'

/** The fields of a vessel node in the Signal K full data model that we read. */
export interface VesselNode {
  name?: string
  mmsi?: string
  navigation?: {
    // Values come from the network as-is, so their shape is checked, not assumed.
    position?: { value?: { latitude?: unknown; longitude?: unknown } | null; timestamp?: string }
    courseOverGroundTrue?: { value?: number | null; timestamp?: string }
    speedOverGround?: { value?: number | null; timestamp?: string }
  }
}

/**
 * A vessel node, or a radar or camera target dressed as one. The extra fields
 * default to an AIS vessel's.
 */
export interface TargetNode extends VesselNode {
  /** Context to publish `navigation.closestApproach` on. */
  context?: string
  /** Signal K path the alarm points at. */
  targetRef?: string
  source?: string
  /** Sensor kinds that see the target, when several do. */
  sources?: string[]
}

export interface EvaluatorOptions {
  zones: Zone[]
  /** Zones used instead of `zones` while own ship and the target are both slower than `slowSpeed`. */
  slowZones: Zone[]
  /** Speed (m/s) below which `slowZones` apply; 0 turns this off. */
  slowSpeed: number
  /** Most targets alarmed at once; the most urgent ones win. */
  maxAlarms: number
  /** Targets farther away than this (metres) are not evaluated. */
  maxRange: number
  /** Data older than this (seconds) is ignored. */
  maxAge: number
}

export interface Evaluation {
  targetId: string
  /** Context to publish `navigation.closestApproach` on. */
  context: string
  result: CpaResult | null
}

// Below this speed (m/s, about 0.5 kn) a vessel is treated as stationary.
// Boats at anchor report up to 0.4 kn with COG swinging through 200° while
// their position stays within a few metres; taken at face value, that noise
// reads as two moored neighbours closing on each other.
const STATIONARY_SPEED = 0.26

// A boat at anchor can only be hit by steering into it, so it is judged by the
// slow zones even while own ship is moving. Its reported speed must rise this
// far above the stationary threshold before it counts as moving again.
const STOPPED_RELEASE_SPEED = 0.51

// A boat's speed must rise this far (m/s, about 0.5 kn) above the slow
// threshold before the normal zones return, so speed noise around the
// threshold does not swap the zones, and with them the alarm, every update.
const SLOW_RELEASE_MARGIN = 0.25

// A target passes astern when, at closest approach, it lies more than 105°
// off own ship's bow (cos 105° = -0.26), and counts as ahead again once
// within 75°, so a target near abeam does not swap between the two.
const ASTERN_ENTER = -0.26
const ASTERN_LEAVE = 0.26

// A target already alarmed ranks as if its closest approach came this many
// seconds sooner, so two targets of similar urgency don't take turns at the
// last alarm slot, which would re-sound the alarm every few seconds.
const RAISED_PRIORITY = 60

interface Candidate {
  targetId: string
  node: TargetNode
  level: AlertLevel
  result: CpaResult
  target: Track
}

/**
 * @param stoppedBelow speed (m/s) below which the vessel counts as stopped
 */
export function toTrack(
  node: VesselNode | undefined,
  nowMs: number,
  maxAge: number,
  stoppedBelow = STATIONARY_SPEED
): Track | null {
  const nav = node?.navigation
  if (!nav?.position || !nav.speedOverGround) {
    return null
  }
  const { latitude, longitude } = nav.position.value ?? {}
  const sog = nav.speedOverGround.value
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    typeof sog !== 'number' ||
    isStale(nav.position.timestamp, nowMs, maxAge) ||
    isStale(nav.speedOverGround.timestamp, nowMs, maxAge)
  ) {
    return null
  }
  const position = { latitude, longitude }
  if (sog < stoppedBelow) {
    return { position, sog: 0, cog: 0 }
  }
  const cog = nav.courseOverGroundTrue?.value
  if (typeof cog !== 'number' || isStale(nav.courseOverGroundTrue?.timestamp, nowMs, maxAge)) {
    return null
  }
  return { position, sog, cog }
}

/**
 * Own ship as the evaluator sees it. At anchor, own GPS reports the yaw and
 * swing of the hull every second, in gusts often above half a knot with a
 * course all round the compass, which would set own ship moving towards every
 * neighbour in turn. Stopped, own ship needs the speed a stopped target needs
 * before it counts as moving again. It starts out stopped: the server mostly
 * starts with the boat in harbour or at anchor, and under way it is soon
 * faster than that.
 */
export class OwnShip {
  private stopped = true

  track(node: VesselNode | undefined, nowMs: number, maxAge: number): Track | null {
    const track = toTrack(
      node,
      nowMs,
      maxAge,
      this.stopped ? STOPPED_RELEASE_SPEED : STATIONARY_SPEED
    )
    if (track) {
      this.stopped = track.sog === 0
    }
    return track
  }
}

/** When the vessel's position was reported, ms since the epoch; NaN when unknown. */
export function positionTime(node: VesselNode | undefined): number {
  return Date.parse(node?.navigation?.position?.timestamp ?? '')
}

function isStale(timestamp: string | undefined, nowMs: number, maxAge: number): boolean {
  if (!timestamp) {
    return true
  }
  const t = Date.parse(timestamp)
  return !Number.isFinite(t) || nowMs - t > maxAge * 1000
}

function describe(id: string, node: VesselNode | undefined): string {
  return node?.name ?? (node?.mmsi ? `MMSI ${node.mmsi}` : id)
}

export function formatMessage(name: string, result: CpaResult): string {
  const nm = (result.cpa / 1852).toFixed(2)
  const minutes = Math.max(0, Math.round(result.tcpa / 60))
  return `Collision risk: ${name}, CPA ${nm} NM in ${minutes} min`
}

function isSlow(sog: number, slowSpeed: number, wasSlow: boolean): boolean {
  return slowSpeed > 0 && sog < (wasSlow ? slowSpeed + SLOW_RELEASE_MARGIN : slowSpeed)
}

function passesAstern(own: Track, result: CpaResult, wasAstern: boolean): boolean {
  if (own.sog === 0 || result.cpa === 0) {
    return false
  }
  const cosOffBow = result.ahead / result.cpa
  return cosOffBow < (wasAstern ? ASTERN_LEAVE : ASTERN_ENTER)
}

/** CPA distance of the most severe zone, metres. */
function innermostCpa(zones: Zone[]): number {
  const strictest = zones.reduce<Zone | undefined>(
    (best, z) => (best === undefined || SEVERITY[z.level] > SEVERITY[best.level] ? z : best),
    undefined
  )
  return strictest?.cpa ?? 0
}

function contextOf(targetId: string, node: TargetNode | undefined): string {
  return node?.context ?? `vessels.${targetId}`
}

/**
 * Evaluates every target against own ship and drives the alarm sink.
 * Holds the per-target alert level so hysteresis survives between ticks.
 *
 * Every target keeps its level, but only the `maxAlarms` most urgent are
 * raised: arriving in a crowded anchorage would otherwise raise one alarm per
 * moored boat ahead.
 */
export class Evaluator {
  private readonly levels = new Map<string, AlertLevel>()
  private slow = false
  private slowTargets = new Set<string>()
  private stoppedTargets = new Set<string>()
  private asternTargets = new Set<string>()
  private readonly raised = new Set<string>()
  private readonly drift = new DriftDetector()

  constructor(
    private readonly options: EvaluatorOptions,
    private readonly sink: AlarmSink
  ) {}

  /**
   * @param own own ship, or null when its own data is missing/stale
   * @param vessels AIS vessels and sensor targets, keyed by id
   */
  evaluate(
    own: Track | null,
    vessels: Record<string, TargetNode>,
    selfId: string,
    nowMs: number
  ): Evaluation[] {
    const evaluations: Evaluation[] = []
    const ownSlow = this.updateOwnSlow(own)
    const slowTargets = new Set<string>()
    const stoppedTargets = new Set<string>()
    const asternTargets = new Set<string>()
    const candidates: Candidate[] = []
    const seen = new Set<string>()

    for (const [targetId, node] of Object.entries(vessels)) {
      if (targetId === selfId || targetId === 'self') {
        continue
      }
      seen.add(targetId)
      const reported = own ? toTrack(node, nowMs, this.options.maxAge) : null
      const target = reported && this.drift.apply(targetId, reported, positionTime(node))
      const result = own && target ? computeCpa(own, target) : null
      const context = contextOf(targetId, node)
      if (!target || !result || result.range > this.options.maxRange) {
        evaluations.push({ targetId, context, result: null })
        continue
      }
      evaluations.push({ targetId, context, result })

      // A fast target keeps the normal zones even then: a ship bearing down on
      // a yacht ghosting along in light air needs the early warning.
      const targetSlow = isSlow(target.sog, this.options.slowSpeed, this.slowTargets.has(targetId))
      if (targetSlow) {
        slowTargets.add(targetId)
      }
      // A boat found drifting is moving, whatever it reports.
      const stopped =
        target === reported &&
        target.sog < (this.stoppedTargets.has(targetId) ? STOPPED_RELEASE_SPEED : STATIONARY_SPEED)
      if (stopped) {
        stoppedTargets.add(targetId)
      }
      const zones =
        (ownSlow && targetSlow) || (stopped && this.options.slowSpeed > 0)
          ? this.options.slowZones
          : this.options.zones
      // A target crossing behind us is no threat unless it comes really close,
      // so it raises nothing while its CPA stays outside the innermost zone's
      // distance. One that will come that close, such as a ship overtaking
      // straight up our wake, keeps every zone and so its early warning, and
      // a level already raised follows the normal hysteresis.
      const astern = own !== null && passesAstern(own, result, this.asternTargets.has(targetId))
      if (astern) {
        asternTargets.add(targetId)
      }
      const current = this.levels.get(targetId)
      const passesWideAstern = astern && current === undefined && result.cpa > innermostCpa(zones)
      const level = passesWideAstern ? undefined : assess(zones, result.cpa, result.tcpa, current)
      if (level) {
        candidates.push({ targetId, node, level, result, target })
      }
    }

    this.slowTargets = slowTargets
    this.stoppedTargets = stoppedTargets
    this.asternTargets = asternTargets
    this.drift.retain(seen)
    this.levels.clear()
    for (const c of candidates) {
      this.levels.set(c.targetId, c.level)
    }
    const shown = candidates
      .sort((a, b) => this.compareUrgency(a, b))
      .slice(0, this.options.maxAlarms)
    const shownIds = new Set(shown.map((c) => c.targetId))
    // Clear displaced alarms first, so no more than maxAlarms are ever raised.
    for (const targetId of [...this.raised]) {
      if (!shownIds.has(targetId)) {
        this.raised.delete(targetId)
        this.sink.set(targetId, undefined)
      }
    }
    for (const c of shown) {
      this.raised.add(c.targetId)
      this.sink.set(c.targetId, this.alert(c.targetId, c.node, c.level, c.result, c.target))
    }
    return evaluations
  }

  stop(): void {
    this.levels.clear()
    this.slowTargets.clear()
    this.stoppedTargets.clear()
    this.asternTargets.clear()
    this.raised.clear()
    this.drift.clear()
    this.sink.clearAll()
  }

  private updateOwnSlow(own: Track | null): boolean {
    if (own) {
      this.slow = isSlow(own.sog, this.options.slowSpeed, this.slow)
    }
    return this.slow
  }

  /**
   * Orders the most urgent first: higher level, then still approaching before
   * already passed (a level is held briefly after closest approach), then the
   * sooner closest approach.
   */
  private compareUrgency(a: Candidate, b: Candidate): number {
    return (
      SEVERITY[b.level] - SEVERITY[a.level] ||
      Number(a.result.tcpa < 0) - Number(b.result.tcpa < 0) ||
      this.rankedTcpa(a) - this.rankedTcpa(b)
    )
  }

  private rankedTcpa(c: Candidate): number {
    return c.result.tcpa - (this.raised.has(c.targetId) ? RAISED_PRIORITY : 0)
  }

  private alert(
    targetId: string,
    node: TargetNode | undefined,
    level: AlertLevel,
    result: CpaResult,
    target: Track
  ): CollisionAlert {
    return {
      level,
      message: formatMessage(describe(targetId, node), result),
      data: {
        targetRef: node?.targetRef ?? `vessels.${targetId}`,
        source: node?.source ?? 'ais',
        ...(node?.sources && { sources: node.sources }),
        cpa: result.cpa,
        tcpa: result.tcpa,
        range: result.range,
        // A stopped target has no course; its COG is noise.
        targetCog: target.sog > 0 ? target.cog : null,
        targetSog: target.sog,
        cpaPositions: { self: result.ownAtCpa, target: result.targetAtCpa }
      }
    }
  }
}
