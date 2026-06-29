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
  lineCode: string | null
  directionNum: number
  circuitId: number
  destinationStationCode: string | null
  secondsAtLocation: number
  serviceType: string
  carCount: number
}

// A live train resolved to map coordinates via the circuit→route model.
export interface PlacedTrain {
  trainId: string
  line: string
  lat: number
  lon: number
  geomBearing: number // line geometry direction (increasing seq) — for ribbon offset
  direction: number // WMATA DirectionNum (1 or 2)
  destination: string | null
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

    const res = await fetch('https://api.wmata.com/Rail.svc/json/jStations', {
      headers: { api_key: __WMATA_KEY__ },
    })
    if (!res.ok) throw new Error(`Stations fetch failed: ${res.status}`)

    const data = (await res.json()) as { Stations: StationRaw[] }
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
        const res = await fetch(
          'https://api.wmata.com/StationPrediction.svc/json/GetPrediction/All',
          { headers: { api_key: __WMATA_KEY__ } },
        )
        if (!res.ok) throw new Error(`Predictions fetch failed: ${res.status}`)
        const data = (await res.json()) as { Trains: TrainRaw[] }
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
      const res = await fetch(
        'https://api.wmata.com/TrainPositions/StandardRoutes?contentType=json',
        { headers: { api_key: __WMATA_KEY__ } },
      )
      if (!res.ok) throw new Error(`StandardRoutes fetch failed: ${res.status}`)
      const data = (await res.json()) as { StandardRoutes: StandardRouteRaw[] }
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

  // Ordered station coordinates for a line (one direction) — the centerline to
  // draw and to offset into a ribbon. Anchors already include any spliced-in
  // missing stations (see _buildRouteModel), so lines and trains share a path.
  getLinePath(line: string): { lat: number; lon: number }[] {
    const anchors =
      this._routeAnchors.get(`${line}:1`) ?? this._routeAnchors.get(`${line}:2`) ?? []
    return anchors.map(a => ({ lat: a.lat, lon: a.lon }))
  }

  async fetchTrainPositions(): Promise<TrainPosition[]> {
    const res = await fetch(
      'https://api.wmata.com/TrainPositions/TrainPositions?contentType=json',
      { headers: { api_key: __WMATA_KEY__ } },
    )
    if (!res.ok) throw new Error(`TrainPositions fetch failed: ${res.status}`)
    const data = (await res.json()) as { TrainPositions: TrainPositionRaw[] }
    return data.TrainPositions.map(t => ({
      trainId: t.TrainId,
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

    let lat: number, lon: number
    if (next.seq === prev.seq) {
      lat = prev.lat
      lon = prev.lon
    } else {
      const f = Math.max(0, Math.min(1, (seq - prev.seq) / (next.seq - prev.seq)))
      lat = prev.lat + (next.lat - prev.lat) * f
      lon = prev.lon + (next.lon - prev.lon) * f
    }
    // Geometry direction = increasing sequence (matches how the line is drawn).
    // Travel direction is derived from movement between polls on the UI side.
    return {
      trainId: t.trainId,
      line: t.lineCode!,
      lat,
      lon,
      geomBearing: bearingDeg(prev.lat, prev.lon, next.lat, next.lon),
      direction: t.directionNum,
      destination: t.destinationStationCode,
    }
  }
}

export const wmataClient = new WmataClient()
