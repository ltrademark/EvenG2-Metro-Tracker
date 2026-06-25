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

function minToNum(min: string): number {
  if (min === 'ARR') return 0
  if (min === 'BRD') return 0.5
  const n = parseInt(min, 10)
  return isNaN(n) ? 999 : n
}

const STATIONS_KEY = 'wmata.stations'
const STATIONS_TS_KEY = 'wmata.stations_ts'
const CACHE_TTL = 24 * 60 * 60 * 1000

export class WmataClient {
  private _stations: Station[] = []
  private _lastFetchAt = 0
  private _allPredictionsRaw: TrainRaw[] = []
  private _lastPredictions: Train[] = []
  private _consecutiveErrors = 0
  private _bridge: EvenAppBridge | null = null

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
          'https://api.wmata.com/StationPrediction.svc/json/GetStationPredictions/All',
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
}

export const wmataClient = new WmataClient()
