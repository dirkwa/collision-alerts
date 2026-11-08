import { advance, computeCpa, type CpaResult, type Track } from './cpa.js'
import type { AlarmSink, CollisionAlert } from './alarms.js'
import { DriftDetector } from './drift.js'
import { MotionCheck } from './motion.js'
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
  /**
   * Zones used instead of `zones` while own ship and the target are both
   * slower than `slowSpeed`, and for a stopped target. A target own ship
   * overtakes slower than that is judged by `zones` cut to these distances.
   */
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

// A boat's speed must rise this far (m/s, about 0.5 kn) above the slow
// threshold before the normal zones return, so speed noise around the
// threshold does not swap the zones, and with them the alarm, every update.
const SLOW_RELEASE_MARGIN = 0.25

// A target passes astern when, at closest approach, it lies more than 105°
// off own ship's bow (cos 105° = -0.26), and counts as ahead again once
// within 75°, so a target near abeam does not swap between the two.
const ASTERN_ENTER = -0.26
const ASTERN_LEAVE = 0.26

// We come up on a boat from more than 22.5° abaft its beam (COLREG rule 13)
// when its course points away from us within 67.5°.
const ABAFT_BEAM = Math.cos((67.5 * Math.PI) / 180)

// An overtaken boat's closest approach wanders with speed noise as we draw
// abreast, now and then onto our track for a moment. It raises a level only
// once its time in a zone, less a third of its time out of one, adds up to
// this (ms): a boat that turns into us stays in the zone, though it may slip
// out between two of its reports, while noise only dips in. Inside the
// strictest slow zone, where noise hardly reaches, it raises at once.
const OVERTAKEN_RAISE_DELAY = 30_000

// An overtaken boat stays overtaken through this long (ms) without usable data
// on it or on own ship, such as reports without a course. After a longer gap
// it may be doing anything, so it must count as overtaken anew. A boat that
// falls silent stays usable until its data are older than maxAge.
const OVERTAKEN_DATA_GAP = 60_000

// A target is judged where it is now, not where it last reported: own ship's
// position is fresh, while a Class B boat under way reports every 30 s and
// covers 60 m in that at 4 kn. It is carried on at its course and speed for
// no longer than this (ms), one missed Class B report, since it may have
// turned since.
const MAX_DEAD_RECKONING = 60_000

// A target already alarmed ranks as if its closest approach came this many
// seconds sooner, so two targets of similar urgency don't take turns at the
// last alarm slot, which would re-sound the alarm every few seconds.
const RAISED_PRIORITY = 60

interface Candidate {
  targetId: string
  node: TargetNode
  level: AlertLevel
  result: CpaResult
  /** Seconds to closest approach as judged: past for boats keeping their distance. */
  tcpa: number
  target: Track
}

export function toTrack(node: VesselNode | undefined, nowMs: number, maxAge: number): Track | null {
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
  if (sog < STATIONARY_SPEED) {
    return { position, sog: 0, cog: 0 }
  }
  const cog = nav.courseOverGroundTrue?.value
  if (typeof cog !== 'number' || isStale(nav.courseOverGroundTrue?.timestamp, nowMs, maxAge)) {
    return null
  }
  return { position, sog, cog }
}

/**
 * How long (s) a target reported at `positionTime` is carried on to `nowMs`:
 * 0 for a report without a time or from the future.
 */
export function reportAge(positionTime: number, nowMs: number): number {
  const age = Math.min(nowMs - positionTime, MAX_DEAD_RECKONING) / 1000
  return age > 0 ? age : 0
}

/** `track` carried on `seconds` at its course and speed. */
export function deadReckon(track: Track, seconds: number): Track {
  return seconds > 0 && track.sog > 0 ? { ...track, position: advance(track, seconds) } : track
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

/**
 * `zones` with each distance cut to the largest distance of the slow zones at
 * the same or a stricter level (the smallest when none is that strict).
 */
function cutDistances(zones: Zone[], slowZones: Zone[]): Zone[] {
  return zones.map((z) => {
    const caps = slowZones.filter((s) => SEVERITY[s.level] >= SEVERITY[z.level]).map((s) => s.cpa)
    const cap = caps.length > 0 ? Math.max(...caps) : Math.min(...slowZones.map((s) => s.cpa))
    return { ...z, cpa: Math.min(z.cpa, cap) }
  })
}

// The zone sets a target can be judged by, from the most lenient.
const SLOW_SET = 0
const OVERTAKEN_SET = 1
const NORMAL_SET = 2

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
  /** When each overtaken target last had usable data, ms since the epoch. */
  private overtakenTargets = new Map<string, number>()
  /** The zone set each target was judged by at the last evaluation. */
  private zoneSets = new Map<string, number>()
  /** Time each overtaken target without a level has spent in a zone, net (ms), and when it was last judged. */
  private overtakenInZone = new Map<string, { net: number; at: number }>()
  private asternTargets = new Set<string>()
  /** When each target began keeping its distance, ms since the epoch. */
  private keepingDistanceSince = new Map<string, number>()
  private readonly raised = new Set<string>()
  private readonly motion = new MotionCheck()
  private readonly drift = new DriftDetector()
  /** When `evaluate` last ran, ms since the epoch. */
  private lastEvaluation: number | undefined

  /** The normal zones with the slow zones' distances, for overtaken targets. */
  private readonly overtakenZones: Zone[]
  /** The strictest slow zones, inside which an overtaken target raises at once. */
  private readonly overtakenAtOnceZones: Zone[]
  /**
   * Range (m) beyond which no normal zone can raise a boat that moves
   * relative to us no faster than an overtaken one may.
   */
  private readonly overtakenRange: number

  constructor(
    private readonly options: EvaluatorOptions,
    private readonly sink: AlarmSink
  ) {
    this.overtakenZones = cutDistances(options.zones, options.slowZones)
    const strictest = Math.max(...options.slowZones.map((z) => SEVERITY[z.level]))
    this.overtakenAtOnceZones = options.slowZones.filter((z) => SEVERITY[z.level] === strictest)
    const speed = options.slowSpeed + SLOW_RELEASE_MARGIN
    this.overtakenRange = Math.max(0, ...options.zones.map((z) => z.cpa + z.tcpa * speed))
  }

  /**
   * Judges every target against own ship, raises, updates or clears its alarm
   * through the sink, and returns each target's CPA to publish.
   *
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
    const sinceLastEvaluation = nowMs - (this.lastEvaluation ?? nowMs)
    this.lastEvaluation = nowMs
    const ownSlow = this.updateOwnSlow(own)
    const slowTargets = new Set<string>()
    const overtakenTargets = new Map<string, number>()
    const zoneSets = new Map<string, number>()
    const overtakenInZone = new Map<string, { net: number; at: number }>()
    const asternTargets = new Set<string>()
    const keepingDistanceSince = new Map<string, number>()
    const candidates: Candidate[] = []
    const seen = new Set<string>()

    for (const [targetId, node] of Object.entries(vessels)) {
      if (targetId === selfId || targetId === 'self') {
        continue
      }
      seen.add(targetId)
      const time = positionTime(node)
      const raw = own ? toTrack(node, nowMs, this.options.maxAge) : null
      const reported = raw && this.motion.apply(targetId, raw, time)
      const target = reported && this.drift.apply(targetId, reported, time)
      const carried = reportAge(time, nowMs)
      const result = own && target ? computeCpa(own, deadReckon(target, carried)) : null
      const context = contextOf(targetId, node)
      if (!target || !result || result.range > this.options.maxRange) {
        // A short gap in the data doesn't end an overtaking: abreast, the boat
        // could not count as overtaken anew.
        const lastData = this.overtakenTargets.get(targetId)
        if (
          !result &&
          lastData !== undefined &&
          nowMs >= lastData &&
          nowMs - lastData <= OVERTAKEN_DATA_GAP
        ) {
          overtakenTargets.set(targetId, lastData)
          const inZone = this.overtakenInZone.get(targetId)
          if (inZone) {
            overtakenInZone.set(targetId, inZone)
          }
        }
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
      // A boat at anchor can only be hit by steering into it, so it is judged
      // by the slow zones even while own ship is moving. A boat found
      // drifting is moving, whatever it reports.
      const stopped = target === reported && target.sog === 0
      // We overtake a boat when we come up on it from more than 22.5° abaft
      // its beam (COLREG rule 13), faster than it along its course. Gaining
      // on it slowly, we have minutes to act, so it raises only for a closest
      // approach as close as the slow zones demand, though as early as the
      // normal zones would: passing it 0.2 NM off raises nothing, while one
      // that turns into us warns in good time. It stays overtaken while the
      // speed between us stays low, however the bearing swings as we draw
      // abeam and pass, and even should it gain on us again: two boats abreast
      // at nearly the same speed have a closest approach that wanders back and
      // forth with speed noise, which the normal zones would keep alarming
      // for. It is let go once too far off for the normal zones to raise
      // anything at that speed. A boat overtaking us, or one crossing at a
      // fine angle, keeps the normal zones however slowly it closes.
      const wasOvertaken = this.overtakenTargets.has(targetId)
      const overtaken =
        own !== null &&
        isSlow(result.relativeSpeed, this.options.slowSpeed, wasOvertaken) &&
        result.range <= this.overtakenRange &&
        (wasOvertaken ||
          (own.sog * Math.cos(own.cog - target.cog) > target.sog &&
            Math.cos(result.bearing - target.cog) > ABAFT_BEAM))
      if (overtaken) {
        overtakenTargets.set(targetId, nowMs)
      }
      const slow = (ownSlow && targetSlow) || (stopped && this.options.slowSpeed > 0)
      const judgedBy = slow ? SLOW_SET : overtaken ? OVERTAKEN_SET : NORMAL_SET
      let zoneSet = judgedBy
      // A raised level keeps the strictest zones it was judged by until it
      // clears: speed noise near a threshold would otherwise swap the zones
      // every few updates, clearing the alarm and raising it anew, each time
      // with sound.
      const current = this.levels.get(targetId)
      const previous = this.zoneSets.get(targetId)
      if (current !== undefined && previous !== undefined && previous > zoneSet) {
        zoneSet = previous
      }
      zoneSets.set(targetId, zoneSet)
      const zones = this.zonesOf(zoneSet)
      // A target crossing behind us is no threat unless it comes really close,
      // so it raises nothing while its CPA stays outside the innermost zone's
      // distance. One that will come that close, such as a ship overtaking
      // straight up our wake, keeps every zone and so its early warning, and
      // a level already raised follows the normal hysteresis.
      const astern = own !== null && passesAstern(own, result, this.asternTargets.has(targetId))
      if (astern) {
        asternTargets.add(targetId)
      }
      const passesWideAstern = astern && current === undefined && result.cpa > innermostCpa(zones)
      // Boats keeping their distance are at closest approach for as long as
      // they do, which would hold a level raised while one of them moved for
      // good. They count as having passed it when they began, so the level
      // is held only briefly, through a moment's pause.
      let tcpa = result.tcpa
      if (result.keepingDistance) {
        const since = this.keepingDistanceSince.get(targetId) ?? nowMs
        keepingDistanceSince.set(targetId, since)
        tcpa = (since - nowMs) / 1000
      }
      // Carried on, it passed its closest approach since its last report. A
      // boat that has fallen silent may have stopped there, so its level is
      // judged as if it were there until a report shows it past: a level it
      // holds stands, and none is raised, since that needs time still to
      // come. It ranks as passed, so it keeps no place from a boat still
      // approaching.
      const judgedTcpa =
        !result.keepingDistance && target.sog > 0 && tcpa < 0 && tcpa > -carried ? 0 : tcpa
      let level = passesWideAstern ? undefined : assess(zones, result.cpa, judgedTcpa, current)
      // Custom zones can be laxer than the slow ones in places, so the zones
      // held for a raised level don't stop the ones it would be judged by now
      // from raising it further.
      if (zoneSet !== judgedBy) {
        const now = assess(this.zonesOf(judgedBy), result.cpa, judgedTcpa, current)
        if (now && (!level || SEVERITY[now] > SEVERITY[level])) {
          level = now
        }
      }
      if (current === undefined && zoneSet === OVERTAKEN_SET) {
        // An evaluation counts for no more than the time since the one
        // before, so a gap in this boat's data adds little.
        const before = this.overtakenInZone.get(targetId)
        const step = before ? Math.max(0, Math.min(nowMs - before.at, sinceLastEvaluation)) : 0
        const net = Math.max(0, (before?.net ?? 0) + (level ? step : -step / 3))
        overtakenInZone.set(targetId, { net, at: nowMs })
        if (
          net < OVERTAKEN_RAISE_DELAY &&
          assess(this.overtakenAtOnceZones, result.cpa, judgedTcpa, undefined) === undefined
        ) {
          level = undefined
        }
      }
      if (level) {
        candidates.push({ targetId, node, level, result, tcpa, target })
      }
    }

    this.keepingDistanceSince = keepingDistanceSince
    this.slowTargets = slowTargets
    this.overtakenTargets = overtakenTargets
    this.zoneSets = zoneSets
    this.overtakenInZone = overtakenInZone
    this.asternTargets = asternTargets
    this.motion.retain(seen)
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
    this.overtakenTargets.clear()
    this.zoneSets.clear()
    this.lastEvaluation = undefined
    this.overtakenInZone.clear()
    this.asternTargets.clear()
    this.keepingDistanceSince.clear()
    this.raised.clear()
    this.motion.clear()
    this.drift.clear()
    this.sink.clearAll()
  }

  private zonesOf(zoneSet: number): Zone[] {
    return zoneSet === NORMAL_SET
      ? this.options.zones
      : zoneSet === OVERTAKEN_SET
        ? this.overtakenZones
        : this.options.slowZones
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
      Number(a.tcpa < 0) - Number(b.tcpa < 0) ||
      this.rankedTcpa(a) - this.rankedTcpa(b)
    )
  }

  private rankedTcpa(c: Candidate): number {
    return c.tcpa - (this.raised.has(c.targetId) ? RAISED_PRIORITY : 0)
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
