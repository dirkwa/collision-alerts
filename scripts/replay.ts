// Replays a recording through the evaluator, as the plugin would have judged
// it live, and lists every warning and alarm it would have raised.
//
//   npm run replay -- <recording dir> [--preset harbour|coastal|offshore]
//     [--from <ISO time>] [--to <ISO time>] [--while-anchored normal|silent]
//     [--while-moored normal|harbour|silent]
//
// The directory holds (UTC times, `time_utc` in ISO 8601):
// - own_boat_1s.csv: time_utc, lat, lon, cog_true_deg, sog_kn; a blank cell
//   keeps the last value.
// - ais_positions.csv: mmsi, name, time_utc, lat, lon, and optionally
//   cog_true_deg, sog_kn. Without them, course and speed come from the
//   vessel's previous position, as AIS reports them only in a raw log.
// - own_anchor_events.csv (optional): time_utc, path, value; the
//   navigation.state rows give own ship's state.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import { DEFAULTS, limitsFor, type Config } from '../src/config.js'
import type { Track } from '../src/cpa.js'
import { DriftDetector } from '../src/drift.js'
import { Evaluator, positionTime, toTrack, type TargetNode } from '../src/evaluator.js'
import { MotionCheck } from '../src/motion.js'
import type { PresetName } from '../src/zones.js'

const KNOT = 1852 / 3600
const NM = 1852
const DEG = Math.PI / 180
const EARTH_RADIUS = 6371008.8
// Course and speed are taken from two positions this far apart in time (ms)
// at most: further apart, the vessel may have turned or stopped in between.
const MAX_DERIVE_GAP = 15 * 60_000
// How long after a raise the vessel's actual closest approach is looked for (ms).
const LOOK_BACK = 20 * 60_000

type Row = Record<string, string>

function readCsv(file: string): Row[] {
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const columns = header.split(',')
  return lines.map((line) => {
    const cells = line.split(',')
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']))
  })
}

function num(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === '') {
    return undefined
  }
  const n = Number(cell)
  return Number.isFinite(n) ? n : undefined
}

interface Report {
  time: number
  latitude: number
  longitude: number
  cog?: number
  sog?: number
}

function distance(a: Report, b: Report): { north: number; east: number } {
  const north = (b.latitude - a.latitude) * DEG * EARTH_RADIUS
  const east = (b.longitude - a.longitude) * DEG * EARTH_RADIUS * Math.cos(a.latitude * DEG)
  return { north, east }
}

/** Fills in course and speed a report lacks from the report before it. */
function deriveMotion(reports: Report[]): void {
  for (let i = 1; i < reports.length; i++) {
    const r = reports[i]
    if (r.sog !== undefined && r.cog !== undefined) {
      continue
    }
    const before = reports[i - 1]
    if (r.time - before.time > MAX_DERIVE_GAP) {
      continue
    }
    const seconds = (r.time - before.time) / 1000
    const { north, east } = distance(before, r)
    r.sog = Math.hypot(north, east) / seconds
    r.cog = ((Math.atan2(east, north) / DEG + 360) % 360) * DEG
  }
}

/** Where a vessel was at `time`, between the reports either side of it. */
function positionAt(reports: Report[], time: number): Report | undefined {
  const after = reports.findIndex((r) => r.time >= time)
  if (after <= 0) {
    return after === 0 && reports[0].time === time ? reports[0] : undefined
  }
  const a = reports[after - 1]
  const b = reports[after]
  if (b.time - a.time > MAX_DERIVE_GAP) {
    return undefined
  }
  const share = (time - a.time) / (b.time - a.time)
  return {
    time,
    latitude: a.latitude + (b.latitude - a.latitude) * share,
    longitude: a.longitude + (b.longitude - a.longitude) * share
  }
}

/** How close the vessel actually came within LOOK_BACK of `time`, metres. */
function closestActual(own: Report[], reports: Report[], time: number): number | undefined {
  let closest: number | undefined
  for (let t = time; t <= time + LOOK_BACK; t += 5000) {
    const o = positionAt(own, t)
    const v = positionAt(reports, t)
    if (o && v) {
      const { north, east } = distance(o, v)
      const d = Math.hypot(north, east)
      closest = closest === undefined ? d : Math.min(closest, d)
    }
  }
  return closest
}

function iso(time: number): string {
  return new Date(time).toISOString().replace('.000Z', 'Z')
}

/** A navigation node as the server holds it, from one report. */
function node(r: Report, name?: string): TargetNode {
  const timestamp = new Date(r.time).toISOString()
  return {
    name,
    navigation: {
      position: { value: { latitude: r.latitude, longitude: r.longitude }, timestamp },
      courseOverGroundTrue: r.cog === undefined ? undefined : { value: r.cog, timestamp },
      speedOverGround: r.sog === undefined ? undefined : { value: r.sog, timestamp }
    }
  }
}

interface Raise {
  time: number
  target: string
  level: string
  data: CollisionAlert['data']
  ownSog: number
  state: string | undefined
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: 'string', default: DEFAULTS.preset },
    from: { type: 'string' },
    to: { type: 'string' },
    'while-anchored': { type: 'string', default: DEFAULTS.whileAnchored },
    'while-moored': { type: 'string', default: DEFAULTS.whileMoored }
  }
})
const dir = positionals[0]
if (!dir) {
  console.error('usage: npm run replay -- <recording dir> [options]')
  process.exit(2)
}
const config: Config = {
  ...DEFAULTS,
  preset: values.preset as PresetName,
  whileAnchored: values['while-anchored'] as Config['whileAnchored'],
  whileMoored: values['while-moored'] as Config['whileMoored']
}

// Own ship: each column keeps its last value, with the time it arrived.
const ownRows = readCsv(join(dir, 'own_boat_1s.csv'))
const own: Report[] = []
let last: Partial<Report> = {}
for (const row of ownRows) {
  const time = Date.parse(row.time_utc)
  const latitude = num(row.lat) ?? last.latitude
  const longitude = num(row.lon) ?? last.longitude
  const cog = num(row.cog_true_deg)
  const sogKn = num(row.sog_kn)
  last = {
    latitude,
    longitude,
    cog: cog === undefined ? last.cog : cog * DEG,
    sog: sogKn === undefined ? last.sog : sogKn * KNOT
  }
  if (latitude !== undefined && longitude !== undefined) {
    own.push({ time, latitude, longitude, cog: last.cog, sog: last.sog })
  }
}

const states: Array<{ time: number; value: string }> = []
const eventsFile = join(dir, 'own_anchor_events.csv')
if (existsSync(eventsFile)) {
  for (const row of readCsv(eventsFile)) {
    if (row.path === 'navigation.state') {
      states.push({ time: Date.parse(row.time_utc), value: row.value })
    }
  }
}

const names = new Map<string, string>()
const byVessel = new Map<string, Report[]>()
for (const row of readCsv(join(dir, 'ais_positions.csv'))) {
  const latitude = num(row.lat)
  const longitude = num(row.lon)
  if (latitude === undefined || longitude === undefined) {
    continue
  }
  const id = `urn:mrn:imo:mmsi:${row.mmsi}`
  names.set(id, row.name || row.mmsi)
  const cog = num(row.cog_true_deg)
  const sog = num(row.sog_kn)
  const list = byVessel.get(id) ?? []
  list.push({
    time: Date.parse(row.time_utc),
    latitude,
    longitude,
    cog: cog === undefined ? undefined : cog * DEG,
    sog: sog === undefined ? undefined : sog * KNOT
  })
  byVessel.set(id, list)
}
for (const list of byVessel.values()) {
  list.sort((a, b) => a.time - b.time)
  deriveMotion(list)
}

const raises: Raise[] = []
let current: { ownSog: number; state: string | undefined; time: number } = {
  ownSog: 0,
  state: undefined,
  time: 0
}
const levels = new Map<string, string>()
const LEVELS = ['alert', 'warn', 'alarm', 'emergency']
const rank = (level: string | undefined) => (level === undefined ? -1 : LEVELS.indexOf(level))
const sink: AlarmSink = {
  set(targetId, alert) {
    const before = levels.get(targetId)
    if (alert === undefined) {
      levels.delete(targetId)
      return
    }
    levels.set(targetId, alert.level)
    // A higher level is what sounds; an update or a step down does not.
    if (rank(alert.level) > rank(before)) {
      raises.push({
        time: current.time,
        target: targetId,
        level: alert.level,
        data: alert.data,
        ownSog: current.ownSog,
        state: current.state
      })
    }
  },
  clearAll() {
    levels.clear()
  }
}

const limits = limitsFor(config)
const harbour = limitsFor(config, 'harbour')
const maxAge = config.maxAgeMinutes * 60
const evaluator = new Evaluator(
  {
    zones: limits.zones,
    slowZones: harbour.zones,
    passingDistance: limits.passingDistance,
    slowPassingDistance: harbour.passingDistance,
    slowSpeed: config.slowSpeed * KNOT,
    maxAlarms: config.maxAlarms,
    maxRange: config.maxRange * NM,
    maxAge
  },
  sink
)
const ownMotion = new MotionCheck()
const ownDrift = new DriftDetector()

const from = values.from ? Date.parse(values.from) : own[0].time
const to = values.to ? Date.parse(values.to) : own[own.length - 1].time
const step = config.interval * 1000
let ownIndex = 0
let stateIndex = 0
const nextReport = new Map<string, number>()
let evaluated = 0
for (let now = from; now <= to; now += step) {
  while (ownIndex + 1 < own.length && own[ownIndex + 1].time <= now) ownIndex++
  while (stateIndex < states.length && states[stateIndex].time <= now) stateIndex++
  const state = stateIndex > 0 ? states[stateIndex - 1].value : undefined
  const ownNode = node(own[ownIndex])
  const raw = toTrack(ownNode, now, maxAge)
  const time = positionTime(ownNode)
  const reported = raw && ownMotion.apply('self', raw, time)
  const ownTrack: Track | null = reported && ownDrift.apply('self', reported, time)
  const vessels: Record<string, TargetNode> = {}
  for (const [id, list] of byVessel) {
    let i = nextReport.get(id) ?? 0
    while (i < list.length && list[i].time <= now) i++
    nextReport.set(id, i)
    const latest = list[i - 1] as Report | undefined
    if (latest && now - latest.time <= maxAge * 1000) {
      vessels[id] = node(latest, names.get(id))
    }
  }
  const moored = config.whileMoored === 'harbour' && state === 'moored'
  const quiet =
    ownTrack !== null &&
    ownTrack.sog === 0 &&
    ((config.whileMoored === 'silent' && state === 'moored') ||
      (config.whileAnchored === 'silent' && state === 'anchored'))
  current = { ownSog: own[ownIndex].sog ?? 0, state, time: now }
  evaluator.evaluate(ownTrack, vessels, 'self', now, moored, quiet)
  evaluated++
}

const sounding = raises.filter((r) => r.level !== 'alert')
console.log(
  `${iso(from)} to ${iso(to)}, preset ${config.preset}, ${evaluated} evaluations, ${byVessel.size} vessels`
)
const count = (level: string) => sounding.filter((r) => r.level === level).length
console.log(
  `Raised: ${count('warn')} warnings, ${count('alarm')} alarms, ${count('emergency')} emergencies`
)
for (const r of sounding) {
  const name = names.get(r.target) ?? r.target
  const actual = closestActual(own, byVessel.get(r.target) ?? [], r.time)
  console.log(
    [
      iso(r.time),
      r.level.padEnd(7),
      name.padEnd(20),
      `range ${Math.round(r.data.range)} m`,
      `CPA ${Math.round(r.data.cpa)} m in ${Math.round(r.data.tcpa)} s`,
      `came to ${actual === undefined ? '?' : Math.round(actual)} m`,
      `its speed ${(r.data.targetSog / KNOT).toFixed(1)} kn`,
      `own ${(r.ownSog / KNOT).toFixed(1)} kn`,
      r.state ?? ''
    ].join('  ')
  )
}
