import type { LatLon, Track } from './cpa.js'

// Boats at anchor report speeds of a few tenths of a knot with a random
// course, so a stopped boat is treated as stationary. A boat dragging its
// anchor or drifting free moves just as slowly, but its position keeps moving
// the same way over minutes, while the noise of one lying still stays within
// about 10 m. Its measured motion replaces the reported "stopped".
//
// A boat swinging at anchor also moves the same way for minutes, as far as
// twice its scope, but along an arc round its anchor, while a dragging boat
// moves in a straight line. Only movement long and straight enough to tell
// the two apart counts as drift.

/** How far back positions are kept, ms. AIS boats at anchor report every 3 min. */
const WINDOW = 10 * 60_000
/** Positions closer together in time than this are skipped, ms. */
const SAMPLE_SPACING = 30_000
/** The positions must span at least this long before drift is judged, ms. */
const MIN_SPAN = 4 * 60_000
/** Net movement over the window that counts as drifting, metres. */
const MIN_DRIFT = 60
/** Both halves of the window must each cover this share of the net movement, so a boat that moved once and stopped, or swung out and back, is not drifting. */
const STEADY_SHARE = 0.25
/** No position may lie farther off the straight line from first to last than this share of the net movement. A 60° swing bows out by 0.13 of its chord, position noise by a few metres. */
const MAX_BOW = 0.1

const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180

interface Sample {
  time: number
  position: LatLon
}

/**
 * Remembers the recent positions of boats that report themselves stopped, and
 * gives a steadily drifting one its measured course and speed.
 */
export class DriftDetector {
  private readonly history = new Map<string, Sample[]>()

  /**
   * @param track the boat as reported, `sog` 0 when it reports being stopped
   * @param positionTime when the position was reported, ms since the epoch
   * @returns the track, with the measured motion when the boat is drifting
   */
  apply(id: string, track: Track, positionTime: number): Track {
    if (track.sog > 0) {
      this.history.delete(id)
      return track
    }
    const samples = this.record(id, track.position, positionTime)
    const drift = measure(samples)
    return drift ? { position: track.position, ...drift } : track
  }

  /** Forgets every boat not in `ids`. */
  retain(ids: Set<string>): void {
    for (const id of this.history.keys()) {
      if (!ids.has(id)) {
        this.history.delete(id)
      }
    }
  }

  clear(): void {
    this.history.clear()
  }

  private record(id: string, position: LatLon, time: number): Sample[] {
    const samples = this.history.get(id) ?? []
    const last = samples.at(-1)
    if (!last || time >= last.time + SAMPLE_SPACING) {
      samples.push({ time, position })
    }
    while (samples[0].time < time - WINDOW) {
      samples.shift()
    }
    this.history.set(id, samples)
    return samples
  }
}

function measure(samples: Sample[]): { sog: number; cog: number } | null {
  if (samples.length < 3) {
    return null
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  const span = last.time - first.time
  if (span < MIN_SPAN) {
    return null
  }
  const [dx, dy] = offset(first.position, last.position)
  const distance = Math.hypot(dx, dy)
  if (distance < MIN_DRIFT) {
    return null
  }
  const middle = closestInTime(samples, first.time + span / 2)
  const [mx, my] = offset(first.position, middle.position)
  const firstHalf = (mx * dx + my * dy) / distance
  const secondHalf = distance - firstHalf
  if (Math.min(firstHalf, secondHalf) < STEADY_SHARE * distance) {
    return null
  }
  if (bow(samples, dx, dy, distance) > MAX_BOW * distance) {
    return null
  }
  return { sog: distance / (span / 1000), cog: (Math.atan2(dx, dy) + 2 * Math.PI) % (2 * Math.PI) }
}

/** Farthest any position lies off the line from the first along (dx, dy), metres. */
function bow(samples: Sample[], dx: number, dy: number, distance: number): number {
  const first = samples[0].position
  return samples.reduce((most, s) => {
    const [x, y] = offset(first, s.position)
    return Math.max(most, Math.abs(x * dy - y * dx) / distance)
  }, 0)
}

function closestInTime(samples: Sample[], time: number): Sample {
  return samples.reduce((best, s) =>
    Math.abs(s.time - time) < Math.abs(best.time - time) ? s : best
  )
}

/** East and north offset of `to` from `from`, metres. */
function offset(from: LatLon, to: LatLon): [number, number] {
  const cosLat = Math.cos(from.latitude * DEG)
  const dLon = ((((to.longitude - from.longitude + 180) % 360) + 360) % 360) - 180
  return [dLon * DEG * cosLat * EARTH_RADIUS, (to.latitude - from.latitude) * DEG * EARTH_RADIUS]
}
