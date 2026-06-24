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
  private _stations: Station[]
  private _onStationChange: StationChangeCb
  private _onPositionUpdate: PositionUpdateCb
  private _watchId: number | null = null
  private _currentCode: string | null = null
  private _retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    stations: Station[],
    onStationChange: StationChangeCb,
    onPositionUpdate: PositionUpdateCb,
  ) {
    this._stations = stations
    this._onStationChange = onStationChange
    this._onPositionUpdate = onPositionUpdate
  }

  start() {
    // One-shot call first to trigger the permission dialog proactively
    navigator.geolocation.getCurrentPosition(
      pos => this._handlePosition(pos),
      err => this._handleError(err),
      { enableHighAccuracy: false, timeout: 10_000 },
    )
    this._watchId = navigator.geolocation.watchPosition(
      pos => this._handlePosition(pos),
      err => this._handleError(err),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 30_000 },
    )
  }

  stop() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId)
      this._watchId = null
    }
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
  }

  private _handlePosition(pos: GeolocationPosition) {
    const { latitude, longitude } = pos.coords
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

  private _handleError(err: GeolocationPositionError) {
    console.warn('GPS error:', err.code, err.message)
    if (err.code === GeolocationPositionError.POSITION_UNAVAILABLE) {
      this._retryTimer = setTimeout(() => this.start(), 30_000)
    }
    window.dispatchEvent(new CustomEvent('gps-error', { detail: { code: err.code } }))
  }
}
