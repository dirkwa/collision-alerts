import { describe, expect, it } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import {
  Evaluator,
  OwnShip,
  toTrack,
  type EvaluatorOptions,
  type VesselNode
} from '../src/evaluator.js'
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

describe('OwnShip', () => {
  it('stays stopped at anchor while gusts yaw the GPS speed up to 1 kn', () => {
    const ownShip = new OwnShip()
    expect(ownShip.track(vessel(50, 1, 40, 0.1), NOW, 360)).toMatchObject({ sog: 0 })
    expect(ownShip.track(vessel(50, 1, 220, 0.45), NOW, 360)).toMatchObject({ sog: 0 })
  })

  it('starts out stopped, so a restart at anchor in a gust raises nothing', () => {
    expect(new OwnShip().track(vessel(50, 1, 220, 0.45), NOW, 360)).toMatchObject({ sog: 0 })
  })

  it('moves once faster than 1 kn, and stops again below 0.5 kn', () => {
    const ownShip = new OwnShip()
    expect(ownShip.track(vessel(50, 1, 90, 0.6), NOW, 360)).toMatchObject({ sog: 0.6 })
    expect(ownShip.track(vessel(50, 1, 90, 0.45), NOW, 360)).toMatchObject({ sog: 0.45 })
    expect(ownShip.track(vessel(50, 1, 90, 0.2), NOW, 360)).toMatchObject({ sog: 0 })
  })

  it('does not alarm for a neighbour at anchor while own GPS speed is gust noise', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const ownShip = new OwnShip()
    // 60 m north; own GPS reports 0.9 kn straight at it.
    const neighbour = { [OTHER]: vessel(50 + 60 / 1852 / 60, 1, 0, 0.05) }
    ev.evaluate(ownShip.track(vessel(50, 1, 0, 0.2), NOW, 360), neighbour, SELF, NOW)
    ev.evaluate(ownShip.track(vessel(50, 1, 0, 0.45), NOW, 360), neighbour, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
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

  it('alarms for a boat closing slowly on one at anchor', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 100 m north at 1 kn (0.51 m/s) straight at us: closest approach in about 3 min.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 100 / 1852 / 60, 1, 180, 0.51) }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
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
