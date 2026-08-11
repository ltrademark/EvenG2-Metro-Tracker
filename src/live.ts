import { wmataClient, bearingDeg } from './wmata'
import type { Station, PlacedTrain } from './wmata'
import type { LiveStripModel, LiveStopKind, LiveTrain } from './glasses'

// Minimum alignment between the heading and the first step of a candidate
// direction for it to count as "the way we're going" — cos(θ), so this admits
// roughly ±78°. Below it the direction is a guess, and callers should say so
// rather than commit to one.
export const MIN_HEADING_ALIGNMENT = 0.2

// Which line the rider is on and which way along it they're going, expressed as
// a step through the line's station sequence.
export interface LineDirection {
  line: string
  step: 1 | -1
  alignment: number
}

// Score both directions of every line serving `current` against the heading and
// return the best, or null when nothing aligns well enough. At a multi-line
// station this is also what settles which line we're on: the line whose next stop
// best matches where we're actually pointed.
export function chooseLineAndDirection(current: Station, heading: number): LineDirection | null {
  const ownCodes = new Set(
    [current.code, current.secondaryCode].filter((c): c is string => c != null),
  )
  let best: LineDirection | null = null

  for (const line of current.lines) {
    const seq = wmataClient.getLineStationCodes(line)
    if (seq.length < 2) continue
    const here = seq.findIndex(c => ownCodes.has(c))
    if (here < 0) continue

    for (const step of [1, -1] as const) {
      const nextStation = wmataClient.getStationByCode(seq[here + step] ?? '')
      if (!nextStation) continue
      const stepBearing = bearingDeg(current.lat, current.lon, nextStation.lat, nextStation.lon)
      const alignment = Math.cos(((stepBearing - heading) * Math.PI) / 180)
      if (!best || alignment > best.alignment) best = { line, step, alignment }
    }
  }

  return best && best.alignment >= MIN_HEADING_ALIGNMENT ? best : null
}

// How often the strip recomputes its position. Only the stop row changes, and
// only when the train has moved far enough to shift it by a whole space glyph, so
// most ticks cost no BLE traffic at all.
const POLL_MS = 15_000

// Smallest change in stop-sequence units that counts as movement rather than feed
// jitter. A train covers roughly 0.1 to 0.3 stops between polls, so this is well
// below a real step and well above a circuit-level wobble at a platform.
const MIN_OBSERVED_STEP = 0.02

// Everything the strip needs from the rest of the app, read fresh on each tick
// rather than pushed, so a tick always draws current state.
export interface LiveInputs {
  // The station the strip is drawn around, which is whatever the timetable is
  // showing rather than always the rider's own: the strip replaces the arrivals
  // panel, so it follows the same station that panel would have described.
  station: Station | null
  // Whether `station` is the rider's own. A GPS fix only says where the *rider* is,
  // so it may only be used to position the strip when the two are the same.
  atOwnStation: boolean
  lat: number
  lon: number
  heading: number | null
  routesFailed: boolean
}

export class LiveStripController {
  private _timer: ReturnType<typeof setInterval> | null = null
  // Line and orientation are latched on entry, not re-derived per tick: the
  // heading is noisy enough that re-deriving it would make the strip flip
  // back and forth while the train is simply moving in a straight line.
  private _latch: { line: string; step: 1 | -1; forCode: string } | null = null
  // Per-latch cache. Rebuilding the stop list is cheap, but getConnectionCodes
  // walks every line's topology, so it is worth not doing 4 times a minute.
  private _cache: { line: string; codes: string[]; kinds: LiveStopKind[] } | null = null
  // DEV only. The simulator implements no location API, so the position never
  // moves there and the strip can't be swept for screenshots without a way to
  // nudge it by hand. Always 0 in production.
  private _devOffset = 0
  private _trains: PlacedTrain[] = []
  // Train direction, measured rather than inferred. See _observeDirections.
  private _lastPos = new Map<string, number>()
  private _observed = new Map<string, boolean>()

  constructor(
    private _inputs: () => LiveInputs,
    private _onTick: () => void,
  ) {}

  get active(): boolean {
    return this._timer !== null
  }

  // Entering the view. Latching here (rather than on the first tick) is what
  // makes the orientation reflect the heading at the moment the rider looked.
  start(): void {
    if (this._timer) return
    this._relatch()
    this._timer = setInterval(() => void this._tick(), POLL_MS)
    void this._tick()
  }

  // Draw first, then fetch, then draw again. Entering the view is instant that
  // way, with trains filling in a moment later rather than the whole strip
  // waiting on the network. The second draw is nearly free when nothing moved,
  // because the renderer skips containers whose content is unchanged.
  private async _tick(): Promise<void> {
    this._onTick()
    try {
      // Throttled inside the client, so this mostly returns the array the phone
      // map already fetched rather than issuing a second request.
      this._trains = wmataClient.placeTrains(await wmataClient.fetchTrainPositions())
      this._observeDirections()
    } catch (err) {
      console.warn('Live train positions unavailable:', err)
    }
    if (this._timer) this._onTick()   // dropped if the view was left mid-fetch
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  // Explicit user reversal, for when the heading guessed wrong or the rider is
  // standing still. Only the orientation flips; the line stays put.
  flipDirection(): void {
    if (this._latch) this._latch = { ...this._latch, step: this._latch.step === 1 ? -1 : 1 }
  }

  private _relatch(): void {
    const { station, heading } = this._inputs()
    if (!station) { this._latch = null; return }
    const chosen = heading !== null ? chooseLineAndDirection(station, heading) : null
    // What we had, if it still applies to this station. Without a confident heading
    // the previous orientation is a better answer than a fresh default: a train
    // standing at a platform reports no useful heading, and resetting to the
    // sequence's own direction there would flip the strip mid-journey.
    const kept = this._latch && station.lines.includes(this._latch.line) ? this._latch : null
    // No confident heading and nothing to keep still gets a strip: the station's own
    // line in the sequence's direction. The press affordance is there to correct it.
    const line = chosen?.line ?? kept?.line ?? station.lines[0]
    if (!line) { this._latch = null; return }
    const step = chosen?.step ?? (kept?.line === line ? kept.step : 1)

    const lineChanged = this._latch?.line !== line
    this._latch = { line, step, forCode: station.code }
    if (lineChanged) {
      this._cache = null
      // Train positions are in the latched line's index space, so observations of
      // which way each train was moving mean nothing once the line changes. They
      // deliberately survive a mere change of station on the same line, since
      // that happens at every stop and re-earning them takes a whole poll.
      this._lastPos.clear()
      this._observed.clear()
    }
  }

  private _stops(line: string): { codes: string[]; kinds: LiveStopKind[] } | null {
    if (this._cache?.line === line) return this._cache
    const codes = wmataClient.getLineStationCodes(line)
    if (codes.length < 2) return null
    const connections = wmataClient.getConnectionCodes()
    const kinds = codes.map((code, i): LiveStopKind => {
      if (i === 0 || i === codes.length - 1) return 'terminus'
      // Two ways to be a transfer: a single-platform junction where lines branch
      // (route topology), or a dual-platform interchange (two station codes).
      const station = wmataClient.getStationByCode(code)
      if (connections.has(code) || station?.secondaryCode) return 'transfer'
      return 'stop'
    })
    this._cache = { line, codes, kinds }
    return this._cache
  }

  // Index of a station within a line's sequence, tolerating the second code a
  // shared platform can be listed under.
  private _indexOf(codes: string[], station: Station): number {
    const direct = codes.indexOf(station.code)
    if (direct >= 0) return direct
    return station.secondaryCode ? codes.indexOf(station.secondaryCode) : -1
  }

  // Where the rider is, in fractional stop-sequence units.
  //
  // GPS is deliberately not the only source and won't be the primary one: it dies
  // underground, which is exactly where this view is being looked at. Snapping to
  // the current station is the floor, and the only source the simulator can
  // exercise at all. Following a locked train from the positions feed is the
  // network-based source that survives tunnels, and is the next one to land.
  private _position(line: string, codes: string[], station: Station): number | null {
    const { lat, lon, atOwnStation } = this._inputs()
    // Projecting the rider's fix onto a line they aren't travelling is meaningless:
    // the projection clamps to the nearest point on the polyline, so browsing a
    // distant station would place them at whichever end of it happened to be
    // closest. Away from their own station the anchor stop is the honest answer.
    const projected =
      atOwnStation && (lat !== 0 || lon !== 0)
        ? wmataClient.getLineSeqPositionForPoint(line, lat, lon)
        : null
    const base = projected ?? this._indexOf(codes, station)
    return base >= 0 ? base + this._devOffset : null
  }

  // DEV only: shift the strip by a fraction of a stop, to verify the sub-pitch
  // slide and the scroll-off behaviour without a moving train.
  devScrub(delta: number): void {
    this._devOffset += delta
  }

  private _note(text: string): LiveStripModel {
    return {
      line: '', destAhead: '', destBehind: '', stops: [], position: 0, trains: [], note: text,
    }
  }

  // Live trains on the stretch of line being drawn, in the same fractional
  // stop-sequence units as the rider. Trains whose bracketing stops aren't on this
  // line drop out, which is what confines the strip to the track in front of the
  // rider while still admitting a second line that shares it (a Yellow train on
  // Blue Line track, say, which is exactly the case worth seeing).
  private _liveTrains(line: string, last: number, flip: boolean): LiveTrain[] {
    const out: LiveTrain[] = []
    for (const train of this._trains) {
      const placed = wmataClient.getLineSeqPosition(line, train)
      if (!placed) continue
      const forward = this._observed.get(train.trainId) ?? placed.forward
      out.push({
        line: train.line,
        position: flip ? last - placed.position : placed.position,
        // Flipping the strip flips which way "onward" points, so a train that was
        // heading right is now heading left.
        rightward: flip ? !forward : forward,
      })
    }
    return out
  }

  // Which way each train is actually going, from where it was last poll.
  //
  // The direction implied by the route model is only a guess, because it reduces to
  // which of a line's two tracks lists the train's circuit, and that is wrong often
  // enough to matter (2 of 15 trains, measured against observed movement). WMATA's
  // DirectionNum is no help either: it reads like a track number but is not one.
  // Watching the position change is the one signal that cannot be misread, and is
  // what the phone map already relies on. The route-model guess still covers a
  // train's first sighting, when there is nothing to compare against yet.
  private _observeDirections(): void {
    const line = this._latch?.line
    if (!line) return
    for (const train of this._trains) {
      const placed = wmataClient.getLineSeqPosition(line, train)
      if (!placed) continue
      const previous = this._lastPos.get(train.trainId)
      if (previous !== undefined && Math.abs(placed.position - previous) >= MIN_OBSERVED_STEP) {
        this._observed.set(train.trainId, placed.position > previous)
      }
      this._lastPos.set(train.trainId, placed.position)
    }
    // Forget trains that have left the feed, so a long ride can't grow these maps
    // without bound.
    const live = new Set(this._trains.map(t => t.trainId))
    for (const id of [...this._lastPos.keys()]) {
      if (!live.has(id)) {
        this._lastPos.delete(id)
        this._observed.delete(id)
      }
    }
  }

  model(): LiveStripModel {
    const { station, routesFailed } = this._inputs()
    if (!station) return this._note('Locating...')
    if (!wmataClient.hasRouteModel()) {
      return this._note(routesFailed ? 'Line map unavailable' : 'Loading line...')
    }

    // Re-latch whenever the anchor station changes, which covers browsing to
    // another station, riding to the next stop, and a first tick that ran before
    // any station was known. _relatch keeps the current line and orientation when
    // they still apply, so this is cheap and does not disturb a journey.
    if (!this._latch || this._latch.forCode !== station.code) this._relatch()
    if (!this._latch) return this._note('Line unknown')

    const { line, step } = this._latch
    const stops = this._stops(line)
    if (!stops) return this._note('Line map unavailable')

    const position = this._position(line, stops.codes, station)
    if (position === null) return this._note('Off route')

    // The renderer only ever draws left to right, so travelling against the
    // sequence is handled here by reversing both the stops and the position.
    const flip = step === -1
    const last = stops.codes.length - 1
    const codes = flip ? [...stops.codes].reverse() : stops.codes
    const kinds = flip ? [...stops.kinds].reverse() : stops.kinds
    const name = (code: string) => wmataClient.getStationByCode(code)?.name ?? ''

    return {
      line,
      destAhead: name(codes[last]),
      destBehind: name(codes[0]),
      stops: kinds,
      position: flip ? last - position : position,
      trains: this._liveTrains(line, last, flip),
      note: null,
    }
  }
}
