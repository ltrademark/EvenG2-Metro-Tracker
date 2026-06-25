import { AppLocationAccuracy } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge, AppLocation } from '@evenrealities/even_hub_sdk'
import type { Station } from './wmata'

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

type StationChangeCb = (station: Station, distKm: number) => void
type PositionUpdateCb = (lat: number, lon: number) => void

export class LocationManager {
  private _bridge: EvenAppBridge
  private _stations: Station[]
  private _onStationChange: StationChangeCb
  private _onPositionUpdate: PositionUpdateCb
  private _currentCode: string | null = null
  private _unsubscribe: (() => void) | null = null
  private _running = false

  constructor(
    bridge: EvenAppBridge,
    stations: Station[],
    onStationChange: StationChangeCb,
    onPositionUpdate: PositionUpdateCb,
  ) {
    this._bridge = bridge
    this._stations = stations
    this._onStationChange = onStationChange
    this._onPositionUpdate = onPositionUpdate
  }

  start() {
    if (this._running) return
    this._running = true
    // Register listener before starting updates so no position is missed
    this._unsubscribe = this._bridge.onAppLocationChanged(loc => this._handle(loc))
    void this._bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.Medium,
      distanceFilter: 50,  // update every 50m of movement
    })
  }

  stop() {
    this._running = false
    this._unsubscribe?.()
    this._unsubscribe = null
    void this._bridge.stopAppLocationUpdates()
  }

  private _handle(loc: AppLocation) {
    const { latitude, longitude } = loc
    this._onPositionUpdate(latitude, longitude)

    let nearest: Station | null = null
    let nearestDist = Infinity
    for (const s of this._stations) {
      const d = haversineKm(latitude, longitude, s.lat, s.lon)
      if (d < nearestDist) {
        nearestDist = d
        nearest = s
      }
    }

    if (nearest && nearest.code !== this._currentCode) {
      this._currentCode = nearest.code
      this._onStationChange(nearest, nearestDist)
    }
  }
}
