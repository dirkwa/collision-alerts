import { describe, expect, it } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import { Evaluator, toTrack, type EvaluatorOptions, type VesselNode } from '../src/evaluator.js'
import { PRESETS } from '../src/zones.js'
import { defined } from './helpers.js'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const fresh = new Date(NOW - 5000).toISOString()

function vessel(lat: number, lon: number, cogDeg: number, sog: number, name?: string): VesselNode {
  return {
    name,
    navigation: {
      position: { value: { latitude: lat, longitude: lon }, timestamp: fresh },
      courseOverGroundTrue: { value: (cogDeg * Math.PI) / 180, timestamp: fresh },
      speedOverGround: { value: sog, timestamp: fresh }
    }
  }
}

class RecordingSink implements AlarmSink {
  calls: Array<[string, CollisionAlert | undefined]> = []
  cleared = false
  set(id: string, alert: CollisionAlert | undefined) {
    this.calls.push([id, alert])
  }
  clearAll() {
    this.cleared = true
  }
}

const own = defined(toTrack(vessel(50, 1, 0, 5), NOW, 360))
const SELF = 'urn:mrn:imo:mmsi:111111111'
const OTHER = 'urn:mrn:imo:mmsi:222222222'
const THIRD = 'urn:mrn:imo:mmsi:333333333'
const FOURTH = 'urn:mrn:imo:mmsi:444444444'

function setup(options: Partial<EvaluatorOptions> = {}) {
  const sink = new RecordingSink()
  const ev = new Evaluator(
    {
      zones: PRESETS.coastal,
      slowZones: PRESETS.harbour,
      slowSpeed: 0,
      maxAlarms: 3,
      maxRange: 12 * 1852,
      maxAge: 360,
      ...options
    },
    sink
  )
  return { sink, ev }
}

describe('toTrack', () => {
  it('rejects stale positions', () => {
    const v = vessel(50, 1, 0, 5)
    defined(defined(v.navigation).position).timestamp = new Date(NOW - 400_000).toISOString()
    expect(toTrack(v, NOW, 360)).toBeNull()
  })

  it('treats a vessel below steerage speed as stationary even without COG', () => {
    const v = vessel(50, 1, 0, 0.05)
    delete defined(v.navigation).courseOverGroundTrue
    expect(toTrack(v, NOW, 360)).toMatchObject({ sog: 0 })
  })

  it('rejects a moving vessel without COG', () => {
    const v = vessel(50, 1, 0, 5)
    delete defined(v.navigation).courseOverGroundTrue
    expect(toTrack(v, NOW, 360)).toBeNull()
  })
})

describe('a boat dragging its anchor', () => {
  it('alarms although it reports being stopped', () => {
    const { sink, ev } = setup()
    const still = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 150 m north, reporting 0.05 m/s with a random course, drifting south at 0.2 m/s.
    for (let minute = 0; minute <= 6; minute++) {
      const time = NOW - (6 - minute) * 60_000
      const north = 150 - 0.2 * 60 * minute
      const node = vessel(50 + north / 111_195, 1, 123, 0.05)
      const nav = defined(node.navigation)
      for (const field of [nav.position, nav.courseOverGroundTrue, nav.speedOverGround]) {
        defined(field).timestamp = new Date(time).toISOString()
      }
      ev.evaluate(still, { [OTHER]: node }, SELF, time)
      if (minute === 0) {
        expect(sink.calls).toEqual([])
      }
    }
    expect(sink.calls.at(-1)?.[1]?.level).toBe('warn')
  })
})

describe('Evaluator', () => {
  it('does not alarm for two boats at anchor whose AIS speed is noise', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 90, 0.2), NOW, 360))
    // 40 m north, reporting 0.4 kn straight at us.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 40 / 1852 / 60, 1, 180, 0.2) }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
  })

  it('does not alarm for a neighbour at anchor reporting 0.9 kn as it yaws in a gust', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 60 m north, reporting 0.9 kn straight at us.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 60 / 1852 / 60, 1, 180, 0.46) }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
  })

  it('alarms for a boat closing at 0.9 kn once its position bears that out', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // From 250 m north at 0.9 kn straight at us, reporting every 10 s, until
    // its closest approach is 5 min away.
    for (let s = 0; s <= 250; s += 10) {
      const closing = vessel(50 + (250 - 0.46 * s) / 1852 / 60, 1, 180, 0.46)
      defined(defined(closing.navigation).position).timestamp = new Date(
        NOW + s * 1000
      ).toISOString()
      ev.evaluate(anchored, { [OTHER]: closing }, SELF, NOW + s * 1000)
    }
    expect(sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
  })

  it('alarms for a boat closing slowly on one at anchor', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 100 m north at 1 kn (0.51 m/s) straight at us: closest approach in about 3 min.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 100 / 1852 / 60, 1, 180, 0.51) }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
  })

  it('clears the alarm once a neighbour that closed on us at anchor stops', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    const north = 50 + 80 / 1852 / 60
    ev.evaluate(anchored, { [OTHER]: vessel(north, 1, 180, 1) }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    const still = { [OTHER]: vessel(north, 1, 180, 0.1) }
    // Held through a moment's pause, like a target just past closest approach.
    ev.evaluate(anchored, still, SELF, NOW)
    ev.evaluate(anchored, still, SELF, NOW + 20_000)
    expect(sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
    ev.evaluate(anchored, still, SELF, NOW + 40_000)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('ranks a boat that stopped near us below one still approaching', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour, maxAlarms: 1 })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    const north = 50 + 80 / 1852 / 60
    ev.evaluate(anchored, { [OTHER]: vessel(north, 1, 180, 1) }, SELF, NOW)
    // It stops, held at warn, while a second boat closes from the south: 90 m
    // at 1 kn, warn too.
    const both = {
      [OTHER]: vessel(north, 1, 180, 0.1),
      [THIRD]: vessel(50 - 90 / 1852 / 60, 1, 0, 0.51)
    }
    ev.evaluate(anchored, both, SELF, NOW + 2000)
    ev.evaluate(anchored, both, SELF, NOW + 4000)
    expect(sink.calls.at(-1)).toEqual([THIRD, expect.objectContaining({ level: 'warn' })])
  })

  describe('a target crossing our track', () => {
    // 1 NM west heading east at our speed (5 m/s); it crosses ahead of us
    // when it starts more than 1 NM north, astern when less.
    const crossing = (northNm: number) =>
      vessel(50 + northNm / 60, 1 - 1 / 60 / Math.cos((50 * Math.PI) / 180), 90, 5)

    it('warns when it will pass ahead within the warning distance', () => {
      const { sink, ev } = setup()
      // CPA 0.28 NM, 0.2 NM ahead of us, in 7.4 min.
      ev.evaluate(own, { [OTHER]: crossing(1.4) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('stays quiet when it will pass astern at the same distance', () => {
      const { sink, ev } = setup()
      // CPA 0.28 NM, 0.2 NM astern of us, in 5 min.
      ev.evaluate(own, { [OTHER]: crossing(0.6) }, SELF, NOW)
      expect(sink.calls).toHaveLength(0)
    })

    it('warns early when it is on a near collision course that passes just astern', () => {
      const { sink, ev } = setup()
      // CPA 26 m astern in 6.1 min: outside the alarm time, inside the warning.
      ev.evaluate(own, { [OTHER]: crossing(0.98) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('still alarms when it will pass close astern', () => {
      const { sink, ev } = setup()
      // CPA 0.14 NM, inside the 0.25 NM alarm distance, in 5.6 min.
      ev.evaluate(own, { [OTHER]: crossing(0.8) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

  it('raises an alarm for a closing target and names it', () => {
    const { sink, ev } = setup()
    // 1 NM ahead, coming straight at us at 5 m/s: TCPA ~185 s.
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5, 'Nordic Star') }, SELF, NOW)
    const [id, alert] = sink.calls[0]
    expect(id).toBe(OTHER)
    expect(alert?.level).toBe('alarm')
    expect(alert?.message).toContain('Nordic Star')
    expect(alert?.data).toMatchObject({ targetRef: `vessels.${OTHER}`, source: 'ais' })
  })

  it("carries the target's course and speed in the alarm", () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    expect(sink.calls[0][1]?.data).toMatchObject({ targetCog: Math.PI, targetSog: 5 })
  })

  it('gives a stopped target no course in the alarm', () => {
    const { sink, ev } = setup()
    // We steam at a boat lying still 0.1 NM ahead.
    ev.evaluate(own, { [OTHER]: vessel(50 + 0.1 / 60, 1, 270, 0.05) }, SELF, NOW)
    expect(sink.calls[0][1]?.data).toMatchObject({ targetCog: null, targetSog: 0 })
  })

  it('raises one alarm per closing target and clears each independently', () => {
    const { sink, ev } = setup()
    // One dead ahead, one on the starboard bow, both closing.
    const ahead = vessel(50 + 1 / 60, 1, 180, 5, 'Nordic Star')
    const starboard = vessel(50 + 1 / 60, 1 + 1 / 60, 225, 5, 'Baltic Wind')
    ev.evaluate(own, { [OTHER]: ahead, [THIRD]: starboard }, SELF, NOW)

    const raised = new Map(sink.calls)
    expect([...raised.keys()]).toEqual([OTHER, THIRD])
    expect(raised.get(OTHER)?.message).toContain('Nordic Star')
    expect(raised.get(OTHER)?.data.targetRef).toBe(`vessels.${OTHER}`)
    expect(raised.get(THIRD)?.message).toContain('Baltic Wind')
    expect(raised.get(THIRD)?.data.targetRef).toBe(`vessels.${THIRD}`)

    // The ship ahead drops out; the other keeps its alarm.
    sink.calls = []
    ev.evaluate(own, { [THIRD]: starboard }, SELF, NOW)
    expect(sink.calls).toContainEqual([OTHER, undefined])
    expect(sink.calls).toContainEqual([THIRD, expect.objectContaining({ level: 'alarm' })])
  })

  it('skips own ship', () => {
    const { sink, ev } = setup()
    const evaluations = ev.evaluate(own, { [SELF]: vessel(50, 1, 0, 5) }, SELF, NOW)
    expect(evaluations).toHaveLength(0)
    expect(sink.calls).toHaveLength(0)
  })

  it('clears the alarm when the target disappears', () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    ev.evaluate(own, {}, SELF, NOW)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('clears every alarm when own ship data goes stale', () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    ev.evaluate(null, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('ignores targets beyond the range limit', () => {
    const { sink, ev } = setup()
    const evaluations = ev.evaluate(own, { [OTHER]: vessel(50 + 20 / 60, 1, 180, 20) }, SELF, NOW)
    expect(evaluations[0].result).toBeNull()
    expect(sink.calls).toHaveLength(0)
  })

  it('clears outstanding alarms on stop', () => {
    const { sink, ev } = setup()
    ev.stop()
    expect(sink.cleared).toBe(true)
  })

  it('uses the slow zones while own ship is slow, with a margin before leaving them', () => {
    // A boat 0.2 NM ahead, 150 m to starboard of our track, coming our way at
    // 0.6 m/s: inside the Coastal limits, outside the Harbour ones.
    const target = vessel(
      50 + 0.2 / 60,
      1 + 150 / 1852 / 60 / Math.cos((50 * Math.PI) / 180),
      180,
      0.6
    )
    const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))

    const normal = setup()
    normal.ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(normal.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])

    const { sink, ev } = setup({ slowSpeed: 1.5 })
    ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    // Just above the threshold the slow zones still hold.
    ev.evaluate(at(1.6), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  describe('a boat at anchor we pass under way', () => {
    const anchoredAt = (northNm: number, eastM: number, sog = 0) =>
      vessel(50 + northNm / 60, 1 + eastM / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 309, sog)

    it('is judged by the Harbour limits', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 0.2 NM ahead, 150 m off our track: a Coastal alarm, nothing in Harbour.
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      // Dead ahead it still alarms.
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 0) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when Harbour limits are turned off', () => {
      const { sink, ev } = setup()
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays stopped while its reported speed hovers near the threshold', () => {
      // A Harbour-limits speed below the stopped boat's reported speed.
      const { sink, ev } = setup({ slowSpeed: 0.1 })
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150, 0.4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })
  })

  describe('a boat we overtake', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    // Own ship makes 5 m/s on 000°; the other boat 4 m/s on the same course.
    const sameCourse = (northM: number, eastM: number, sog = 4, cogDeg = 0) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, cogDeg, sog)
    // 300 m ahead, 370 m to starboard: CPA 370 m in 5 min, a Coastal alarm.
    const abeam = (sog?: number) => sameCourse(300, 370, sog)
    // A boat `rangeM` off on the given true bearing from us.
    const bearingFrom = (rangeM: number, bearingDeg: number, cogDeg: number, sog: number) => {
      const b = (bearingDeg * Math.PI) / 180
      return sameCourse(rangeM * Math.cos(b), rangeM * Math.sin(b), sog, cogDeg)
    }
    const stamped = (node: VesselNode, time: number) => {
      const nav = defined(node.navigation)
      for (const field of [nav.position, nav.courseOverGroundTrue, nav.speedOverGround]) {
        defined(field).timestamp = new Date(time).toISOString()
      }
      return node
    }
    const levels = (sink: RecordingSink) => sink.calls.map(([, alert]) => alert?.level)
    // Evaluates every 2 s from `from` (ms) for `seconds`, with `node` as it is.
    const hold = (ev: Evaluator, node: VesselNode, from: number, seconds: number) => {
      for (let s = 0; s <= seconds; s += 2) {
        ev.evaluate(own, { [OTHER]: node }, SELF, from + s * 1000)
      }
    }

    it('raises nothing when we pass it 370 m off', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('keeps the normal limits when Harbour limits are turned off', () => {
      const { sink, ev } = setup()
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('warns as early as the normal limits when it is right on our track, after 30 s', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 600 m dead ahead: CPA 0 in 10 min, outside the Harbour limits' 5 min.
      hold(ev, sameCourse(600, 0), NOW, 28)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 30_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('warns but does not alarm for a pass 80 m off, and holds the warning', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 300 m ahead, 80 m to starboard: CPA 80 m in 5 min, a Coastal alarm,
      // but outside the Harbour alarm distance of 50 m.
      hold(ev, sameCourse(300, 80), NOW, 40)
      expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn', 'warn'])
    })

    it('escalates a raised level at once', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(300, 80), NOW, 30)
      // Now 300 m dead ahead: CPA 0 in 5 min, inside the alarm zone.
      ev.evaluate(own, { [OTHER]: sameCourse(300, 0) }, SELF, NOW + 32_000)
      expect(levels(sink)).toEqual(['warn', 'alarm'])
    })

    it('rides out moments outside the zone, as between two reports', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every five evaluations, one sees CPA 150 m, outside the zone.
      for (let s = 0; s <= 60; s += 2) {
        const node = s % 10 === 8 ? sameCourse(600, 150) : sameCourse(600, 0)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
      }
      expect(levels(sink)).toContain('warn')
    })

    it('counts a moment outside as a third of one inside', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every five evaluations, two in a row see CPA 0: in the zone 4 s,
      // out of it 6 s, so 2 s more in every 10 s.
      let raisedAt: number | undefined
      for (let s = 0; s <= 300 && raisedAt === undefined; s += 2) {
        const node = s % 10 < 4 ? sameCourse(600, 0) : sameCourse(600, 150)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
        if (sink.calls.length > 0) {
          raisedAt = s
        }
      }
      expect(raisedAt).toBeGreaterThanOrEqual(140)
      expect(raisedAt).toBeLessThanOrEqual(160)
    })

    it('ignores brief moments in the zone, as from speed noise', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every ten evaluations, two in a row see CPA 0, inside the zone.
      for (let s = 0; s <= 300; s += 2) {
        const node = s % 20 < 4 ? sameCourse(600, 0) : sameCourse(600, 150)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
      }
      expect(sink.calls).toEqual([])
    })

    it('alarms at once inside the Harbour alarm limits only', () => {
      // 250 m ahead, 80 m to starboard: CPA 80 m in 250 s, a Harbour warning.
      const warn = setup({ slowSpeed: 1.5 })
      warn.ev.evaluate(own, { [OTHER]: sameCourse(250, 80) }, SELF, NOW)
      expect(warn.sink.calls).toEqual([])
      // 100 m dead ahead: CPA 0 in 100 s, a Harbour alarm.
      const alarm = setup({ slowSpeed: 1.5 })
      alarm.ev.evaluate(own, { [OTHER]: sameCourse(100, 0) }, SELF, NOW)
      expect(alarm.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
      // 130 m ahead, 30 m to starboard: CPA 30 m, but in 130 s.
      const later = setup({ slowSpeed: 1.5 })
      later.ev.evaluate(own, { [OTHER]: sameCourse(130, 30) }, SELF, NOW)
      expect(later.sink.calls).toEqual([])
      // 100 m ahead, 60 m to starboard: in 100 s, but CPA 60 m.
      const wider = setup({ slowSpeed: 1.5 })
      wider.ev.evaluate(own, { [OTHER]: sameCourse(100, 60) }, SELF, NOW)
      expect(wider.sink.calls).toEqual([])
      // Just inside both limits, CPA 48 m in 118 s; just outside each.
      const at = (northM: number, eastM: number) => {
        const { sink, ev } = setup({ slowSpeed: 1.5 })
        ev.evaluate(own, { [OTHER]: sameCourse(northM, eastM) }, SELF, NOW)
        return levels(sink)
      }
      expect(at(118, 48)).toEqual(['alarm'])
      expect(at(122, 48)).toEqual([])
      expect(at(118, 52)).toEqual([])
    })

    it('does not count time passing wide astern', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // 300 m to starboard, 80 m astern, closing on our wake at 0.75 m/s:
      // CPA 80 m astern in 400 s, outside the 50 m that a boat passing astern
      // must come within to raise anything.
      const astern = (aftM: number) =>
        vessel(
          50 - aftM / 1852 / 60,
          1 + 300 / 1852 / 60 / COS50,
          (Math.atan2(-0.75, 5) * 180) / Math.PI,
          Math.hypot(0.75, 5)
        )
      hold(ev, astern(80), NOW + 2000, 28)
      expect(sink.calls).toEqual([])
      // Now CPA 40 m astern in 400 s: inside, but only from now on.
      ev.evaluate(own, { [OTHER]: astern(40) }, SELF, NOW + 32_000)
      expect(sink.calls).toEqual([])
    })

    it('counts the time in the zone again after a level clears', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(600, 0), NOW, 30)
      // CPA 150 m: the warning clears.
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW + 32_000)
      expect(levels(sink)).toEqual(['warn', undefined])
      hold(ev, sameCourse(600, 0), NOW + 34_000, 20)
      expect(levels(sink)).toEqual(['warn', undefined])
    })

    it('takes the normal limits at once when no longer overtaken', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(300, 80), NOW, 30)
      // It slows to 3 m/s, 2 m/s between us: CPA 80 m in 2.5 min, a Coastal alarm.
      ev.evaluate(own, { [OTHER]: sameCourse(300, 80, 3) }, SELF, NOW + 32_000)
      expect(levels(sink).at(-1)).toBe('alarm')
    })

    it('cuts the distance of every level, an emergency too', () => {
      const zones = [...PRESETS.coastal, { level: 'emergency' as const, cpa: 200, tcpa: 300 }]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // 250 m ahead, 80 m to starboard: CPA 80 m in 250 s, inside the
      // emergency zone as set, outside it cut to 50 m.
      hold(ev, sameCourse(250, 80), NOW, 30)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('counts the time that passes, not the evaluations', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      for (let s = 0; s <= 30; s += 5) {
        ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + s * 1000)
      }
      expect(levels(sink)).toEqual(['warn'])
    })

    it('keeps its time in the zone through a report without a course', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(600, 0), NOW, 20)
      const noCourse = sameCourse(600, 0)
      delete defined(noCourse.navigation).courseOverGroundTrue
      ev.evaluate(own, { [OTHER]: noCourse }, SELF, NOW + 22_000)
      hold(ev, sameCourse(600, 0), NOW + 24_000, 8)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('ignores the clock going back', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW - 120_000)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW - 118_000)
      expect(sink.calls).toEqual([])
    })

    it('counts a gap in its data as one evaluation', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW)
      // Its reports carry no course for a minute.
      const noCourse = sameCourse(600, 0)
      delete defined(noCourse.navigation).courseOverGroundTrue
      hold(ev, noCourse, NOW + 2000, 56)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 60_000)
      expect(sink.calls).toEqual([])
    })

    it('counts a long evaluation interval in full', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 30_000)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('counts from nothing after a long time outside the zone', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 10 min at CPA 150 m, then CPA 0 for 30 s.
      for (let s = 0; s <= 630; s += 2) {
        const time = NOW + s * 1000
        const node = s <= 600 ? sameCourse(600, 150) : sameCourse(600, 0)
        ev.evaluate(own, { [OTHER]: stamped(node, time) }, SELF, time)
      }
      expect(levels(sink)).toEqual(['warn'])
    })

    it('warns as early as the normal limits when it turns into us', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 392 m ahead, 699 m to starboard, on our course: overtaken.
      ev.evaluate(own, { [OTHER]: sameCourse(392, 699) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      // It turns to 345° at 4.5 m/s: still slow between us, but a collision
      // course, CPA 0 in 10 min, warned 30 s on.
      hold(ev, sameCourse(392, 699, 4.5, 345), NOW + 2000, 26)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: sameCourse(392, 699, 4.5, 345) }, SELF, NOW + 30_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('counts as overtaken on our port side, across north', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 350°, sailing 010° at 4 m/s: CPA 158 m in 4.8 min, a
      // Coastal alarm.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 350, 10, 4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('counts as overtaken only from more than 22.5° abaft its beam', () => {
      // 600 m off, on our course: its course 67.4° off the line from us to it,
      // then 67.6°. Both are Coastal warnings, passing over 500 m off.
      const within = setup({ slowSpeed: 1.5 })
      within.ev.evaluate(own, { [OTHER]: bearingFrom(600, 67.4, 0, 4) }, SELF, NOW)
      expect(within.sink.calls).toEqual([])
      const outside = setup({ slowSpeed: 1.5 })
      outside.ev.evaluate(own, { [OTHER]: bearingFrom(600, 67.6, 0, 4) }, SELF, NOW)
      expect(outside.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('stays overtaken as we draw abeam and pass', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // From 600 m ahead, 300 m to starboard, we gain 1 m/s on it. Once it
      // is less than 124 m ahead we no longer come up on it from abaft its
      // beam, and at 100 m ahead the Coastal limits would alarm (CPA 300 m in
      // 100 s).
      for (let s = 0; s <= 700; s += 20) {
        const time = NOW + s * 1000
        ev.evaluate(own, { [OTHER]: stamped(sameCourse(600 - s, 300), time) }, SELF, time)
      }
      expect(sink.calls).toEqual([])
    })

    it('stays overtaken through a moment without own data', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW + 2000)
      // Nearly abeam, 30 m ahead and 300 m to starboard: CPA 300 m in 30 s, a
      // Coastal alarm, and too far abeam to count as overtaken anew.
      ev.evaluate(own, { [OTHER]: sameCourse(30, 300) }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
    })

    it('ignores the clock going back when letting it go', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // The clock goes back an hour, and for 70 s we have no data of our own.
      for (let s = 0; s <= 70; s += 2) {
        ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW - 3_600_000 + s * 1000)
      }
      // 400 m off on 030°, sailing 345° at 4.9 m/s: a Coastal alarm once let go.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW - 3_528_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('is let go after a minute without usable data', () => {
      // Then 400 m off on 030°, sailing 345° at 4.9 m/s and converging: CPA
      // 298 m in 3.4 min, a Coastal alarm. We don't gain on it along its
      // course, so it is not overtaken anew.
      const after = (gapS: number) => {
        const { sink, ev } = setup({ slowSpeed: 1.5 })
        ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
        for (let s = 2; s <= gapS; s += 2) {
          ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW + s * 1000)
        }
        ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW + (gapS + 2) * 1000)
        return sink.calls
      }
      expect(after(50)).toEqual([])
      expect(after(70)).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays overtaken should it come up on us again slowly', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // We pass it 300 m off and sail on until it is 400 m astern.
      for (let s = 0; s <= 1000; s += 20) {
        const time = NOW + s * 1000
        ev.evaluate(own, { [OTHER]: stamped(sameCourse(600 - s, 300), time) }, SELF, time)
      }
      // Then it comes up on us from astern, 0.3 m/s faster: 100 m astern,
      // 200 m to starboard, CPA 200 m in 5.6 min, a Coastal alarm.
      const time = NOW + 1020_000
      ev.evaluate(own, { [OTHER]: stamped(sameCourse(-100, 200, 5.3), time) }, SELF, time)
      expect(sink.calls).toEqual([])
    })

    it('stays overtaken when our wind drops, until it is clearly faster', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // We have drawn abeam, 300 m off on 100°, when our wind drops to 3 m/s.
      const becalmed = defined(toTrack(vessel(50, 1, 0, 3), NOW, 360))
      // At 3.3 and then 4.5 m/s it gains on us, 1.5 m/s at most: still
      // overtaken, though CPA 296 m within 3 min is a Coastal alarm.
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 3.3) }, SELF, NOW + 2000)
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 4.5) }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
      // At 5 m/s, 2 m/s between us, it is overtaking us: the Coastal limits.
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 5) }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('is let go once too far off for the normal limits to raise it', () => {
      // The zones listed strictest first, so the farthest-reaching is not the
      // first.
      const zones = [...PRESETS.coastal].reverse()
      // Later we meet it again 400 m off on 030°, sailing 345° at 4.9 m/s and
      // converging: CPA 298 m in 3.4 min, a Coastal alarm. We don't gain on
      // it along its course, so it is not overtaken anew.
      const again = bearingFrom(400, 30, 345, 4.9)
      // 2100 m astern, within the 2186 m at which the Coastal limits could
      // still raise a boat 1.75 m/s from us: still overtaken.
      const near = setup({ slowSpeed: 1.5, zones })
      near.ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      near.ev.evaluate(own, { [OTHER]: bearingFrom(2100, 180, 0, 4) }, SELF, NOW + 2000)
      near.ev.evaluate(own, { [OTHER]: again }, SELF, NOW + 4000)
      expect(near.sink.calls).toEqual([])
      // 2300 m astern: let go.
      const far = setup({ slowSpeed: 1.5, zones })
      far.ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      far.ev.evaluate(own, { [OTHER]: bearingFrom(2300, 180, 0, 4) }, SELF, NOW + 2000)
      far.ev.evaluate(own, { [OTHER]: again }, SELF, NOW + 4000)
      expect(far.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays overtaken until the speed between us is clearly above the threshold', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // 1.6 m/s between us, just above the threshold: still overtaken.
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: abeam(3) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps an alarm raised under the normal limits until it clears', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 1.6 m/s between us, within the margin but not yet below the threshold:
      // the normal limits, and an alarm.
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
      // Speed noise takes it below the threshold and back: the alarm stands.
      ev.evaluate(own, { [OTHER]: abeam(3.6) }, SELF, NOW + 2000)
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', 'alarm'])
    })

    it('becomes overtaken while an alarm raised under the normal limits stands', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      // Below the threshold it is overtaken, though the alarm stands.
      ev.evaluate(own, { [OTHER]: abeam(3.6) }, SELF, NOW + 2000)
      // 400 m astern, 300 m to starboard: past, and the alarm clears.
      ev.evaluate(own, { [OTHER]: sameCourse(-400, 300) }, SELF, NOW + 4000)
      // It comes up on us again, 0.3 m/s faster: 100 m astern, 300 m to
      // starboard, CPA 300 m in 5.6 min, a Coastal alarm.
      ev.evaluate(own, { [OTHER]: sameCourse(-100, 300, 5.3) }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', undefined])
    })

    it('keeps an alarm raised under the normal limits when we slow down', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // A boat 0.2 NM ahead, 150 m to starboard of our track, coming our way
      // at 0.6 m/s: CPA 150 m within 3 min, a Coastal alarm, nothing in Harbour.
      const target = vessel(50 + 0.2 / 60, 1 + 150 / 1852 / 60 / COS50, 180, 0.6)
      const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
      // We slow below the threshold: both boats slow, but the alarm stands.
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 2000)
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', 'alarm'])
    })

    it('raises a held level further by the limits it is judged by now', () => {
      // Custom limits with an alarm at 25 m, narrower than the Harbour 50 m.
      const zones = [
        { level: 'warn' as const, cpa: 926, tcpa: 720 },
        { level: 'alarm' as const, cpa: 25, tcpa: 360 }
      ]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // 200 m ahead, 40 m to starboard, coming our way at 0.6 m/s.
      const target = vessel(50 + 200 / 1852 / 60, 1 + 40 / 1852 / 60 / COS50, 180, 0.6)
      const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))
      // At 2 m/s, CPA 40 m in 77 s: a warning by the custom limits.
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
      // We slow to 1.4 m/s, both boats slow: CPA 40 m in 100 s, a Harbour alarm.
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 2000)
      // Its CPA wanders out to 55 m and back: the alarm holds by the Harbour
      // limits' margin.
      const wider = vessel(50 + 200 / 1852 / 60, 1 + 55 / 1852 / 60 / COS50, 180, 0.6)
      ev.evaluate(at(1.4), { [OTHER]: wider }, SELF, NOW + 4000)
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['warn', 'alarm', 'alarm', 'alarm'])
    })

    it('counts as overtaken though the normal limits judged it before', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 1500 m ahead, 80 m to starboard, gaining 2 m/s: the normal limits, but
      // CPA is 12.5 min away.
      ev.evaluate(own, { [OTHER]: sameCourse(1500, 80, 3) }, SELF, NOW)
      // It slows our gain to 1 m/s, 300 m ahead: CPA 80 m in 5 min, a Coastal
      // alarm, a warning when overtaken.
      hold(ev, sameCourse(300, 80), NOW + 2000, 32)
      expect(levels(sink)).toEqual(['warn', 'warn'])
    })

    it('keeps the Harbour limits when both boats are slow', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // We make 1.4 m/s; 100 m dead ahead it makes 0.9 m/s on our course: CPA
      // 0 in 200 s, a Harbour warning, an alarm by the normal limits' timing.
      const slowOwn = defined(toTrack(vessel(50, 1, 0, 1.4), NOW, 360))
      ev.evaluate(slowOwn, { [OTHER]: sameCourse(100, 0, 0.9) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('keeps the normal limits for a boat ahead we gain on fast at an angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 010°, sailing 025° at 3.6 m/s: we come up on it from
      // abaft its beam and gain 0.9 m/s on it along its course, but the speed
      // between us is 2.3 m/s. CPA 312 m in 109 s.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 10, 25, 3.6) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

  describe('a boat closing slowly that we do not overtake', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    const at = (northM: number, eastM: number, cogDeg: number, sog: number) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, cogDeg, sog)
    const bearingFrom = (rangeM: number, bearingDeg: number, cogDeg: number, sog: number) => {
      const b = (bearingDeg * Math.PI) / 180
      return at(rangeM * Math.cos(b), rangeM * Math.sin(b), cogDeg, sog)
    }

    it('keeps the normal limits when it crosses at a fine angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // On 345° at our speed, 388 m to starboard and 51 m ahead: a collision
      // course 15° off ours, 1.3 m/s between us. CPA 0 in 5 min.
      ev.evaluate(own, { [OTHER]: at(51, 388, 345, 5) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when it converges at a fine angle and we do not gain on it', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 030°, sailing 345° at 4.9 m/s: we come up on it from
      // abaft its beam and are faster, but not along its course. CPA 298 m
      // in 3.4 min.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when it crosses ahead of us at a fine angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 700 m off on 055°, sailing 345° at 4.6 m/s: ahead of us and slower,
      // but its course is 70° off the line from us to it. CPA 121 m in 8.8 min.
      ev.evaluate(own, { [OTHER]: bearingFrom(700, 55, 345, 4.6) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('keeps the normal limits when it overtakes us', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m astern, 60 m to starboard, 1.2 m/s faster on our course: CPA
      // 60 m in 5.6 min.
      ev.evaluate(own, { [OTHER]: at(-400, 60, 0, 6.2) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

  it('keeps the normal zones for a fast target while own ship is slow', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    const slowOwn = defined(toTrack(vessel(50, 1, 0, 1), NOW, 360))
    // A ship 2 NM ahead at 10 m/s, passing 300 m off: a Coastal alarm, no Harbour one.
    const ship = vessel(50 + 2 / 60, 1 + 300 / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 180, 10)
    ev.evaluate(slowOwn, { [OTHER]: ship }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  it('alarms only the most urgent targets and promotes the next when one clears', () => {
    const { sink, ev } = setup({ maxAlarms: 2 })
    // Three boats dead ahead, closing at 5 m/s from 0.4, 0.6 and 0.8 NM.
    const near = vessel(50 + 0.4 / 60, 1, 180, 5)
    const mid = vessel(50 + 0.6 / 60, 1, 180, 5)
    const far = vessel(50 + 0.8 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: far, [THIRD]: mid, [FOURTH]: near }, SELF, NOW)
    expect(new Map(sink.calls)).toEqual(
      new Map([
        [FOURTH, expect.objectContaining({ level: 'alarm' })],
        [THIRD, expect.objectContaining({ level: 'alarm' })]
      ])
    )

    sink.calls = []
    ev.evaluate(own, { [OTHER]: far, [THIRD]: mid }, SELF, NOW)
    expect(sink.calls).toContainEqual([FOURTH, undefined])
    expect(sink.calls).toContainEqual([OTHER, expect.objectContaining({ level: 'alarm' })])
  })

  it('lets a higher level displace a lower one at the cap', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    // Passing 0.4 NM abeam (warn) versus coming straight at us (alarm).
    const passing = vessel(50 + 0.5 / 60, 1 + 0.4 / 60 / Math.cos((50 * Math.PI) / 180), 180, 5)
    const headOn = vessel(50 + 1 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])

    sink.calls = []
    ev.evaluate(own, { [OTHER]: passing, [THIRD]: headOn }, SELF, NOW)
    expect(sink.calls).toContainEqual([THIRD, expect.objectContaining({ level: 'alarm' })])
    expect(sink.calls).toContainEqual([OTHER, undefined])
  })

  it('keeps an alarmed target over a slightly more urgent newcomer', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    const first = vessel(50 + 0.6 / 60, 1, 180, 5)
    // Closest approach 20 s sooner: not enough to take the slot.
    const second = vessel(50 + 0.6 / 60 - 200 / 1852 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: first }, SELF, NOW)
    sink.calls = []
    ev.evaluate(own, { [OTHER]: first, [THIRD]: second }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  it('ranks a target that has passed below one still approaching', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    // Head-on from 0.1 NM: closest approach in about 18 s.
    const passing = vessel(50 + 0.1 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
    // 20 s later it is 10 m astern, its alarm held just past closest approach.
    const astern = vessel(50 - 10 / 1852 / 60, 1, 180, 5)
    const approaching = vessel(50 + 0.6 / 60, 1, 180, 5)
    sink.calls = []
    ev.evaluate(own, { [OTHER]: astern, [THIRD]: approaching }, SELF, NOW)
    expect(sink.calls).toEqual([
      [OTHER, undefined],
      [THIRD, expect.objectContaining({ level: 'alarm' })]
    ])
  })
})
