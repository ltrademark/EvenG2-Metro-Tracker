import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface Station {
  code: string
  name: string
  lat: number
  lon: number
  secondaryCode: string | null
  lines: string[]
}

export interface Train {
  line: string
  destination: string
  min: string
  car: string
  group: string
}

// A live train from the TrainPositions feed (position is a track-circuit id).
export interface TrainPosition {
  trainId: string
  trainNumber: string
  lineCode: string | null
  directionNum: number
  circuitId: number
  destinationStationCode: string | null
  secondsAtLocation: number
  serviceType: string
  carCount: number
}

// A live train resolved to map coordinates via the circuit→route model.
//
// The placement fields below (routeKey through segFraction) are what _placeOne
// already worked out on the way to a lat/lon, kept rather than discarded. They
// can't be recovered afterwards: inverting a coordinate back to a sequence
// position is ambiguous anywhere the line doubles back on itself.
export interface PlacedTrain {
  trainId: string
  trainNumber: string
  line: string
  lat: number
  lon: number
  geomBearing: number // line geometry direction (increasing seq) — for ribbon offset
  direction: number // WMATA DirectionNum (1 or 2)
  destination: string | null
  carCount: number
  routeKey: string // "LINE:TRACK" the circuit was matched on
  circuitSeq: number // sequence number of that circuit along the route
  prevCode: string // station anchor at or before the train
  nextCode: string // station anchor at or after it
  segFraction: number // 0..1 between prevCode and nextCode
}

interface StationRaw {
  Code: string
  Name: string
  Lat: number
  Lon: number
  StationTogether1: string
  LineCode1: string
  LineCode2: string
  LineCode3: string
  LineCode4: string
}

interface TrainRaw {
  Line: string
  DestinationName: string
  Min: string
  Car: string
  Group: string
  LocationCode: string
}

interface TrainPositionRaw {
  TrainId: string
  TrainNumber: string
  CarCount: number
  DirectionNum: number
  CircuitId: number
  DestinationStationCode: string | null
  LineCode: string | null
  SecondsAtLocation: number
  ServiceType: string
}

interface StandardRouteRaw {
  LineCode: string
  TrackNum: number
  TrackCircuits: { SeqNum: number; CircuitId: number; StationCode: string | null }[]
}

// Initial bearing from point A to point B, in degrees (0 = north).
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLon = toRad(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function minToNum(min: string): number {
  if (min === 'ARR') return 0
  if (min === 'BRD') return 0.5
  const n = parseInt(min, 10)
  return isNaN(n) ? 999 : n
}

const STATIONS_KEY = 'wmata.stations'
const STATIONS_TS_KEY = 'wmata.stations_ts'
const ROUTES_KEY = 'wmata.routes'
const ROUTES_TS_KEY = 'wmata.routes_ts'
const CACHE_TTL = 24 * 60 * 60 * 1000

// `fetch` has no default timeout, so a request made in a tunnel (or anywhere the
// connection is accepted but never answered) can stay pending indefinitely and
// stall whatever awaits it. Every WMATA call goes through here so each one is
// bounded and fails cleanly into the existing error handling.
const FETCH_TIMEOUT_MS = 15_000

// WMATA refreshes TrainPositions roughly every 7-10 seconds, and there are now
// two independent pollers (the phone map and the glasses live strip). Throttling
// inside the client means adding a second consumer costs no extra API calls: a
// caller that arrives early is served the cached array rather than refetching.
const POSITIONS_MIN_INTERVAL_MS = 10_000
const POSITIONS_ERROR_INTERVAL_MS = 60_000

// Stops two lines must have in common before they count as sharing track rather
// than crossing. Lines that share rails (Yellow along Blue, Orange along Silver)
// share a long run of them; lines that merely cross share exactly the interchange,
// so anything above one separates the two cases with room to spare.
const MIN_SHARED_STOPS = 3

async function fetchWmata<T>(url: string, label: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { api_key: __WMATA_KEY__ }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`${label} failed: ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export class WmataClient {
  private _stations: Station[] = []
  private _lastFetchAt = 0
  private _allPredictionsRaw: TrainRaw[] = []
  private _lastPredictions: Train[] = []
  private _consecutiveErrors = 0
  private _bridge: EvenAppBridge | null = null
  private _standardRoutes: StandardRouteRaw[] = []
  // CircuitId → which routes pass through it (with that route's sequence number)
  private _circuitIndex = new Map<number, { key: string; seq: number }[]>()
  // route key "LINE:TRACK" → station anchors along it, sorted by sequence number
  private _routeAnchors = new Map<string, { seq: number; lat: number; lon: number; code: string }[]>()
  private _lastPositions: TrainPosition[] = []
  private _lastPositionsAt = 0
  private _positionErrors = 0
  // line-pair key → whether they share rails. Cleared with the route model.
  private _sharedTrack = new Map<string, boolean>()

  setBridge(bridge: EvenAppBridge) {
    this._bridge = bridge
  }

  async loadStations(): Promise<Station[]> {
    if (this._bridge) {
      const cached = await this._bridge.getLocalStorage(STATIONS_KEY)
      const ts = await this._bridge.getLocalStorage(STATIONS_TS_KEY)
      if (cached && ts && Date.now() - Number(ts) < CACHE_TTL) {
        this._stations = JSON.parse(cached) as Station[]
        return this._stations
      }
    }

    const data = await fetchWmata<{ Stations: StationRaw[] }>(
      'https://api.wmata.com/Rail.svc/json/jStations',
      'Stations fetch',
    )
    this._stations = data.Stations.map(s => ({
      code: s.Code,
      name: s.Name,
      lat: s.Lat,
      lon: s.Lon,
      secondaryCode: s.StationTogether1 || null,
      lines: [s.LineCode1, s.LineCode2, s.LineCode3, s.LineCode4].filter(Boolean),
    }))

    if (this._bridge) {
      await this._bridge.setLocalStorage(STATIONS_KEY, JSON.stringify(this._stations))
      await this._bridge.setLocalStorage(STATIONS_TS_KEY, String(Date.now()))
    }

    return this._stations
  }

  getStations(): Station[] {
    return this._stations
  }

  getStationByCode(code: string): Station | undefined {
    return this._stations.find(s => s.code === code || s.secondaryCode === code)
  }

  async fetchPredictions(station: Station): Promise<Train[]> {
    const now = Date.now()
    const minInterval = this._consecutiveErrors >= 3 ? 5 * 60_000 : 30_000

    if (now - this._lastFetchAt >= minInterval) {
      try {
        const data = await fetchWmata<{ Trains: TrainRaw[] }>(
          'https://api.wmata.com/StationPrediction.svc/json/GetPrediction/All',
          'Predictions fetch',
        )
        this._allPredictionsRaw = data.Trains
        this._lastFetchAt = now
        this._consecutiveErrors = 0
      } catch (err) {
        this._consecutiveErrors++
        console.error('WMATA predictions error:', err)
      }
    }

    return this._filterForStation(station)
  }

  private _filterForStation(station: Station): Train[] {
    const codes = new Set(
      [station.code, station.secondaryCode].filter((c): c is string => c != null),
    )
    const seen = new Set<string>()
    const trains = this._allPredictionsRaw
      .filter(t => codes.has(t.LocationCode))
      .map(t => ({
        line: t.Line,
        destination: t.DestinationName,
        min: t.Min,
        car: t.Car,
        group: t.Group,
      }))
      .filter(t => {
        const key = `${t.line}|${t.destination}|${t.min}|${t.group}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => minToNum(a.min) - minToNum(b.min))
    this._lastPredictions = trains
    return trains
  }

  getLastPredictions(): Train[] {
    return this._lastPredictions
  }

  getConsecutiveErrors(): number {
    return this._consecutiveErrors
  }

  // ── Live train positions ───────────────────────────────────────────────
  //
  // The TrainPositions feed reports each train by track-circuit id, not lat/lon.
  // StandardRoutes gives the ordered circuit sequence per line/track with station
  // codes anchoring known points, so we interpolate a train's position between
  // the stations bracketing its circuit. Requires loadStations() first.

  async loadStandardRoutes(): Promise<void> {
    if (this._standardRoutes.length) return // already loaded + model built
    let routes: StandardRouteRaw[] | null = null
    if (this._bridge) {
      const cached = await this._bridge.getLocalStorage(ROUTES_KEY)
      const ts = await this._bridge.getLocalStorage(ROUTES_TS_KEY)
      if (cached && ts && Date.now() - Number(ts) < CACHE_TTL) {
        routes = JSON.parse(cached) as StandardRouteRaw[]
      }
    }
    if (!routes) {
      const data = await fetchWmata<{ StandardRoutes: StandardRouteRaw[] }>(
        'https://api.wmata.com/TrainPositions/StandardRoutes?contentType=json',
        'StandardRoutes fetch',
      )
      routes = data.StandardRoutes
      if (this._bridge) {
        await this._bridge.setLocalStorage(ROUTES_KEY, JSON.stringify(routes))
        await this._bridge.setLocalStorage(ROUTES_TS_KEY, String(Date.now()))
      }
    }
    this._standardRoutes = routes
    this._buildRouteModel()
  }

  private _buildRouteModel(): void {
    this._circuitIndex = new Map()
    this._routeAnchors = new Map()
    this._sharedTrack = new Map()
    for (const route of this._standardRoutes) {
      const key = `${route.LineCode}:${route.TrackNum}`
      const anchors: { seq: number; lat: number; lon: number; code: string }[] = []
      for (const c of route.TrackCircuits) {
        const arr = this._circuitIndex.get(c.CircuitId) ?? []
        arr.push({ key, seq: c.SeqNum })
        this._circuitIndex.set(c.CircuitId, arr)
        if (c.StationCode) {
          const st = this.getStationByCode(c.StationCode)
          if (st) anchors.push({ seq: c.SeqNum, lat: st.lat, lon: st.lon, code: c.StationCode })
        }
      }
      anchors.sort((a, b) => a.seq - b.seq)

      // WMATA's route data omits some stations (e.g. newly-opened Potomac Yard /
      // C11). Splice each missing line-member station in at its nearest segment
      // with an interpolated sequence number, so BOTH the drawn line and the
      // train positions follow the same path through it.
      if (anchors.length >= 2) {
        const codes = new Set(anchors.map(a => a.code))
        const K = Math.cos((38.9 * Math.PI) / 180)
        const missing = this._stations.filter(
          s =>
            s.lines.includes(route.LineCode) &&
            !codes.has(s.code) &&
            (!s.secondaryCode || !codes.has(s.secondaryCode)),
        )
        for (const m of missing) {
          let bestI = 0
          let bestD = Infinity
          let bestT = 0
          for (let i = 0; i < anchors.length - 1; i++) {
            const ax = anchors[i].lon * K, ay = anchors[i].lat
            const bx = anchors[i + 1].lon * K, by = anchors[i + 1].lat
            const dx = bx - ax, dy = by - ay
            const l2 = dx * dx + dy * dy
            let t = l2 ? ((m.lon * K - ax) * dx + (m.lat - ay) * dy) / l2 : 0
            t = Math.max(0, Math.min(1, t))
            const d = Math.hypot(m.lon * K - (ax + t * dx), m.lat - (ay + t * dy))
            if (d < bestD) { bestD = d; bestI = i; bestT = t }
          }
          const seq =
            anchors[bestI].seq + bestT * (anchors[bestI + 1].seq - anchors[bestI].seq)
          anchors.push({ seq, lat: m.lat, lon: m.lon, code: m.code })
          anchors.sort((a, b) => a.seq - b.seq)
        }
      }

      this._routeAnchors.set(key, anchors)
    }
  }

  // Distinct line codes that have route geometry.
  getLineCodes(): string[] {
    return [...new Set(this._standardRoutes.map(r => r.LineCode))]
  }

  // Whether the circuit→route model is built. Callers that need line geometry
  // have to cope with its absence: loadStandardRoutes is async and can fail, so
  // "no model yet" is a real state and not just a startup instant.
  hasRouteModel(): boolean {
    return this._routeAnchors.size > 0
  }

  // One entry per stop along a line, in running order. A station can anchor more
  // than one circuit, so the raw anchor list repeats it; collapsing consecutive
  // duplicates here (rather than in each caller) is what keeps an index into the
  // station codes and a position on the drawn path referring to the same stop.
  private _dedupedAnchors(line: string): { lat: number; lon: number; code: string }[] {
    const anchors =
      this._routeAnchors.get(`${line}:1`) ?? this._routeAnchors.get(`${line}:2`) ?? []
    const out: { lat: number; lon: number; code: string }[] = []
    for (const a of anchors) {
      if (out[out.length - 1]?.code !== a.code) out.push({ lat: a.lat, lon: a.lon, code: a.code })
    }
    return out
  }

  // Ordered station coordinates for a line (one direction) — the centerline to
  // draw and to offset into a ribbon. Anchors already include any spliced-in
  // missing stations (see _buildRouteModel), so lines and trains share a path.
  getLinePath(line: string): { lat: number; lon: number }[] {
    return this._dedupedAnchors(line).map(a => ({ lat: a.lat, lon: a.lon }))
  }

  // Station codes along a line in running order — the same anchor sequence
  // getLinePath draws, so an index here is directly comparable to a position on
  // that path.
  getLineStationCodes(line: string): string[] {
    return this._dedupedAnchors(line).map(a => a.code)
  }

  // Whether two lines run along the same rails for a stretch, as opposed to merely
  // meeting at an interchange.
  //
  // This is needed because station identity alone can't tell the two apart. Metro
  // Center is one station with two codes (A01 for Red, C01 for Silver) on two
  // separate platforms over different track, so a Silver train standing there
  // resolves to a Red Line stop and looks, by code, exactly like a train on the
  // Red Line. Counting how many stops the lines have in common separates them: a
  // line sharing rails shares a whole run of stops, while a crossing line shares
  // only the interchange.
  sharesTrack(a: string, b: string): boolean {
    if (a === b) return true
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const cached = this._sharedTrack.get(key)
    if (cached !== undefined) return cached
    // Compare resolved station identity, not raw codes, so the dual-code stations
    // this exists to handle are counted once rather than missed.
    const stopIds = (line: string) =>
      new Set(this.getLineStationCodes(line).map(c => this.getStationByCode(c)?.code ?? c))
    const other = stopIds(b)
    let shared = 0
    for (const id of stopIds(a)) if (other.has(id)) shared++
    const result = shared >= MIN_SHARED_STOPS
    this._sharedTrack.set(key, result)
    return result
  }

  // Index of a station code within a line's stop sequence, tolerating the two
  // codes a shared platform can be recorded under (A01 vs C01): the two tracks
  // of a route don't always name it the same way.
  private _seqIndexOf(codes: string[], code: string | null): number {
    if (!code) return -1
    const direct = codes.indexOf(code)
    if (direct >= 0) return direct
    const st = this.getStationByCode(code)
    if (!st) return -1
    return codes.findIndex(c => c === st.code || c === st.secondaryCode)
  }

  // Fractional position of a placed train along a line's stop sequence, e.g.
  // 4.5 = halfway between the 5th and 6th stop, plus which way it is travelling.
  //
  // Interpolating between the two anchor *indices* rather than reusing the raw
  // sequence number is what makes this track-agnostic: track 2 runs the stops in
  // the opposite order, so its nextCode lands at a lower index and the same
  // arithmetic still holds. That also means the sign of the index step is the
  // train's direction of travel in this line's own terms, which is the only frame
  // a caller drawing that line can use. Returns null for a train whose bracketing
  // stops aren't on this line at all, which is how trains on unrelated lines are
  // filtered out from a shared-track view.
  getLineSeqPosition(
    line: string,
    train: PlacedTrain,
  ): { position: number; forward: boolean } | null {
    const codes = this.getLineStationCodes(line)
    if (codes.length < 2) return null
    const iPrev = this._seqIndexOf(codes, train.prevCode)
    const iNext = this._seqIndexOf(codes, train.nextCode)
    if (iPrev < 0 || iNext < 0) return null
    // Both stops being present is not enough: they must be *adjacent* here. A line
    // that merely crosses ours shares its interchange stations, so its trains match
    // by code while running on entirely different track. Requiring consecutive
    // indices admits a line that genuinely shares our rails (Yellow along Blue,
    // where every stop is also ours) and rejects one that only touches us at a
    // transfer, which otherwise put a Green Line train on a Red Line strip.
    if (Math.abs(iNext - iPrev) > 1) return null
    // And the train has to actually be running on these rails. A train standing at
    // a crossing line's shared interchange has both bracketing stops equal to that
    // one station, so the adjacency test above passes it: only comparing the lines
    // themselves rejects it.
    if (!this.sharesTrack(line, train.line)) return null
    return {
      position: iPrev + (iNext - iPrev) * train.segFraction,
      // A train sitting exactly on an anchor has no step to read, so it inherits
      // the direction its track implies rather than being dropped.
      forward: iNext !== iPrev ? iNext > iPrev : train.routeKey.endsWith(':1'),
    }
  }

  // Fractional position of an arbitrary point, by projecting it onto the line's
  // polyline. Used for a GPS fix, which knows nothing about track circuits.
  getLineSeqPositionForPoint(line: string, lat: number, lon: number): number | null {
    const anchors = this._dedupedAnchors(line)
    if (anchors.length < 2) return null
    // Latitude-corrected planar projection: over a single metro line the error is
    // far below the spacing between stops.
    const K = Math.cos((38.9 * Math.PI) / 180)
    const px = lon * K
    let bestI = 0
    let bestD = Infinity
    let bestT = 0
    for (let i = 0; i < anchors.length - 1; i++) {
      const ax = anchors[i].lon * K, ay = anchors[i].lat
      const bx = anchors[i + 1].lon * K, by = anchors[i + 1].lat
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      let t = l2 ? ((px - ax) * dx + (lat - ay) * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(px - (ax + t * dx), lat - (ay + t * dy))
      if (d < bestD) { bestD = d; bestI = i; bestT = t }
    }
    return bestI + bestT
  }

  // Codes of single-platform junction stations — where the lines serving a stop
  // branch onto different track (Rosslyn, Pentagon, Stadium-Armory, East Falls
  // Church, King St, …). Detected from route topology: at a junction the lines
  // through the station don't all share the same neighbours. Dual-platform
  // transfers (Metro Center, Gallery Pl, …) are detected separately via
  // secondaryCode; combine both for "connection"-style station dots.
  getConnectionCodes(): Set<string> {
    // For each station code, the set of adjacent station codes on each line.
    const neighbors = new Map<string, Map<string, Set<string>>>()
    for (const line of this.getLineCodes()) {
      const anchors =
        this._routeAnchors.get(`${line}:1`) ?? this._routeAnchors.get(`${line}:2`) ?? []
      const codes = anchors.map(a => a.code)
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i]
        let perLine = neighbors.get(c)
        if (!perLine) { perLine = new Map(); neighbors.set(c, perLine) }
        let set = perLine.get(line)
        if (!set) { set = new Set(); perLine.set(line, set) }
        if (i > 0 && codes[i - 1] !== c) set.add(codes[i - 1])
        if (i < codes.length - 1 && codes[i + 1] !== c) set.add(codes[i + 1])
      }
    }
    const result = new Set<string>()
    for (const [code, perLine] of neighbors) {
      if (perLine.size < 2) continue   // only one line passes here — not a junction
      const sets = [...perLine.values()]
      const union = new Set<string>()
      sets.forEach(s => s.forEach(x => union.add(x)))
      // If any line's neighbours differ from the combined set, the lines branch.
      if (sets.some(s => s.size !== union.size)) result.add(code)
    }
    return result
  }

  async fetchTrainPositions(): Promise<TrainPosition[]> {
    const now = Date.now()
    const minInterval =
      this._positionErrors >= 3 ? POSITIONS_ERROR_INTERVAL_MS : POSITIONS_MIN_INTERVAL_MS
    if (this._lastPositionsAt && now - this._lastPositionsAt < minInterval) {
      return this._lastPositions
    }
    // Stamped before the request, not after it, so the throttle covers a call
    // that's still in flight as well as one that already finished — otherwise two
    // pollers landing together would both go out over the network.
    this._lastPositionsAt = now
    try {
      this._lastPositions = await this._fetchPositions()
      this._positionErrors = 0
    } catch (err) {
      this._positionErrors++
      console.error('WMATA train positions error:', err)
    }
    return this._lastPositions
  }

  private async _fetchPositions(): Promise<TrainPosition[]> {
    const data = await fetchWmata<{ TrainPositions: TrainPositionRaw[] }>(
      'https://api.wmata.com/TrainPositions/TrainPositions?contentType=json',
      'TrainPositions fetch',
    )
    return data.TrainPositions.map(t => ({
      trainId: t.TrainId,
      trainNumber: t.TrainNumber,
      lineCode: t.LineCode,
      directionNum: t.DirectionNum,
      circuitId: t.CircuitId,
      destinationStationCode: t.DestinationStationCode,
      secondsAtLocation: t.SecondsAtLocation,
      serviceType: t.ServiceType,
      carCount: t.CarCount,
    }))
  }

  placeTrains(trains: TrainPosition[]): PlacedTrain[] {
    const placed: PlacedTrain[] = []
    for (const t of trains) {
      if (!t.lineCode) continue // skip non-revenue / yard trains for now
      const p = this._placeOne(t)
      if (p) placed.push(p)
    }
    return placed
  }

  private _placeOne(t: TrainPosition): PlacedTrain | null {
    const candidates = this._circuitIndex.get(t.circuitId)
    if (!candidates || candidates.length === 0) return null
    // Disambiguate shared track by this train's line.
    //
    // Deliberately NOT by DirectionNum: it reads like a track number but is not
    // one. Matching `LINE:directionNum` puts every direction-1 train on track 1,
    // whose anchors always run in increasing sequence, which made the derived
    // direction of travel unconditionally "forward" and wrong for half the fleet
    // (measured: 10 of 19 against observed movement, versus 2 of 15 without it).
    // Track circuits are physical, so which route lists a circuit is the better
    // signal for which track a train is on.
    const cand =
      candidates.find(c => c.key.startsWith(`${t.lineCode}:`)) ?? candidates[0]
    const anchors = this._routeAnchors.get(cand.key)
    if (!anchors || anchors.length < 2) return null

    const seq = cand.seq
    let prev = anchors[0]
    let next = anchors[anchors.length - 1]
    for (const a of anchors) {
      if (a.seq <= seq) prev = a
      if (a.seq >= seq) { next = a; break }
    }

    // Coincident anchors collapse to f = 0, which lands exactly on prev — the
    // same answer the old special case gave, without the branch.
    const f =
      next.seq === prev.seq
        ? 0
        : Math.max(0, Math.min(1, (seq - prev.seq) / (next.seq - prev.seq)))
    // Geometry direction = increasing sequence (matches how the line is drawn).
    // Travel direction is derived from movement between polls on the UI side.
    return {
      trainId: t.trainId,
      trainNumber: t.trainNumber,
      line: t.lineCode!,
      lat: prev.lat + (next.lat - prev.lat) * f,
      lon: prev.lon + (next.lon - prev.lon) * f,
      geomBearing: bearingDeg(prev.lat, prev.lon, next.lat, next.lon),
      direction: t.directionNum,
      destination: t.destinationStationCode,
      carCount: t.carCount,
      routeKey: cand.key,
      circuitSeq: seq,
      prevCode: prev.code,
      nextCode: next.code,
      segFraction: f,
    }
  }
}

export const wmataClient = new WmataClient()
