import { describe, expect, it } from 'vitest'
import { DriftDetector } from '../src/drift.js'

const T0 = Date.parse('2026-10-11T12:00:00Z')
const MINUTE = 60_000
// Metres to degrees of latitude.
const M = 1 / 111_195

function stopped(northMetres: number, eastMetres = 0) {
  return {
    position: {
      latitude: 50 + northMetres * M,
      longitude: 1 + (eastMetres * M) / Math.cos(50 * (Math.PI / 180))
    },
    sog: 0,
    cog: 0
  }
}

/** Feeds one stopped report per minute and returns the last result. */
function feed(detector: DriftDetector, northByMinute: number[]) {
  return northByMinute
    .map((north, i) => detector.apply('a', stopped(north), T0 + i * MINUTE))
    .at(-1)
}

describe('DriftDetector', () => {
  it('gives a stopped boat that keeps moving the same way its measured motion', () => {
    // 10 m a minute north, for 6 minutes.
    const track = feed(new DriftDetector(), [0, 10, 20, 30, 40, 50, 60])
    expect(track?.sog).toBeCloseTo(60 / 360, 3)
    expect(track?.cog).toBeCloseTo(0, 2)
  })

  it('leaves a boat lying still with position noise stopped', () => {
    expect(feed(new DriftDetector(), [0, 8, -5, 10, -7, 4, 9, -3, 6])?.sog).toBe(0)
  })

  it('leaves a boat that moved once and then lay still stopped', () => {
    expect(feed(new DriftDetector(), [0, 60, 60, 60, 60, 60, 60])?.sog).toBe(0)
  })

  it('waits for a few minutes of positions before judging', () => {
    expect(feed(new DriftDetector(), [0, 30, 60, 90])?.sog).toBe(0)
  })

  it('starts over when the boat reports moving', () => {
    const detector = new DriftDetector()
    feed(detector, [0, 10, 20, 30, 40])
    detector.apply('a', { ...stopped(50), sog: 2 }, T0 + 5 * MINUTE)
    expect(detector.apply('a', stopped(60), T0 + 6 * MINUTE).sog).toBe(0)
  })

  it('measures drift in any direction', () => {
    const detector = new DriftDetector()
    let track
    for (let i = 0; i <= 6; i++) {
      track = detector.apply('a', stopped(0, -10 * i), T0 + i * MINUTE)
    }
    expect(track?.cog).toBeCloseTo((3 * Math.PI) / 2, 2)
  })

  it('leaves a boat swinging round its anchor stopped', () => {
    // 90° round a 60 m rode over 8 minutes, then lying still: the boat moves
    // 85 m the same way, along an arc.
    const detector = new DriftDetector()
    let track
    for (let i = 0; i <= 12; i++) {
      const a = (Math.min(i, 8) / 8) * (Math.PI / 2)
      track = detector.apply('a', stopped(60 * Math.cos(a), 60 * Math.sin(a)), T0 + i * MINUTE)
      expect(track.sog).toBe(0)
    }
  })

  it('still finds a boat dragging in a straight line through position noise', () => {
    const track = feed(new DriftDetector(), [0, 14, 21, 37, 44, 61, 66, 83])
    expect(track?.sog).toBeGreaterThan(0)
  })
})
