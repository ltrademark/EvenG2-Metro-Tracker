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

// ── Motion state ───────────────────────────────────────────────────────────
//
// Derived from GPS so the app can tell "waiting on a platform" from "riding a
// train". Metro trains cruise well above road-walking pace, so a speed
// threshold separates them cleanly; the awkward middle (a slow bus, a car in
// traffic) reads as transit too, which is the harmless direction to err in.
export type MotionState = 'stationary' | 'walking' | 'transit'

// Enter/exit pairs rather than single thresholds: GPS speed is noisy, and a
// single cutoff makes the state flap every few seconds near the boundary.
const TRANSIT_ENTER_MPS = 8    // ~29 km/h
const TRANSIT_EXIT_MPS = 5     // ~18 km/h
const WALK_ENTER_MPS = 0.7
const WALK_EXIT_MPS = 0.4
// Weight on the newest sample. Low enough to ride out a single bad fix, high
// enough to notice a train pulling out within a couple of updates.
const SPEED_SMOOTHING = 0.4
// Underground the fixes simply stop arriving. Rather than trust a stale speed
// forever, decay to stationary — the conservative choice, since every behaviour
// gated on transit degrades to today's distance-based one.
const STALE_FIX_MS = 120_000

function classifyMotion(mps: number, current: MotionState): MotionState {
  if (current === 'transit') {
    if (mps >= TRANSIT_EXIT_MPS) return 'transit'
    return mps >= WALK_EXIT_MPS ? 'walking' : 'stationary'
  }
  if (mps >= TRANSIT_ENTER_MPS) return 'transit'
  if (current === 'walking') return mps >= WALK_EXIT_MPS ? 'walking' : 'stationary'
  return mps >= WALK_ENTER_MPS ? 'walking' : 'stationary'
}

type StationChangeCb = (station: Station, distKm: number) => void
type PositionUpdateCb = (lat: number, lon: number) => void
type MotionChangeCb = (motion: MotionState) => void

// Initial bearing A→B in degrees (0 = north). Local copy so location.ts stays
// independent of the WMATA client.
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLon = toRad(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180) / Math.PI
}

export class LocationManager {
  private _bridge: EvenAppBridge
  private _stations: Station[]
  private _onStationChange: StationChangeCb
  private _onPositionUpdate: PositionUpdateCb
  private _currentCode: string | null = null
  private _unsubscribe: (() => void) | null = null
  private _running = false
  private _onMotionChange: MotionChangeCb | null
  private _lastFix: { lat: number; lon: number; t: number } | null = null
  private _speedMps = 0
  private _motion: MotionState = 'stationary'
  private _heading: number | null = null
  private _staleTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    bridge: EvenAppBridge,
    stations: Station[],
    onStationChange: StationChangeCb,
    onPositionUpdate: PositionUpdateCb,
    onMotionChange: MotionChangeCb | null = null,
  ) {
    this._bridge = bridge
    this._stations = stations
    this._onStationChange = onStationChange
    this._onPositionUpdate = onPositionUpdate
    this._onMotionChange = onMotionChange
  }

  /** Current movement class, derived from GPS speed. */
  get motion(): MotionState {
    return this._motion
  }

  /** Direction of travel in degrees (0 = north), or null if not yet known. */
  get heading(): number | null {
    return this._heading
  }

  /** Smoothed ground speed in m/s — exposed for debugging and display. */
  get speedMps(): number {
    return this._speedMps
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
    // Losing the fix (tunnel, phone stowed) produces silence, not a zero-speed
    // update — so age the state out on a timer rather than waiting for one.
    this._staleTimer = setInterval(() => {
      if (!this._lastFix) return
      if (Date.now() - this._lastFix.t < STALE_FIX_MS) return
      this._speedMps = 0
      this._setMotion('stationary')
    }, 30_000)
  }

  stop() {
    this._running = false
    this._unsubscribe?.()
    this._unsubscribe = null
    if (this._staleTimer) {
      clearInterval(this._staleTimer)
      this._staleTimer = null
    }
    void this._bridge.stopAppLocationUpdates()
  }

  private _setMotion(next: MotionState) {
    if (next === this._motion) return
    this._motion = next
    this._onMotionChange?.(next)
  }

  private _handle(loc: AppLocation) {
    const { latitude, longitude } = loc
    this._updateMotion(loc)
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

  // Speed and heading come straight from the platform when it supplies them
  // (both AppLocation fields are optional), and are otherwise derived from the
  // step since the previous fix.
  private _updateMotion(loc: AppLocation) {
    const { latitude, longitude } = loc
    const t = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now()
    const prev = this._lastFix

    let sample: number | null =
      typeof loc.speed === 'number' && loc.speed >= 0 ? loc.speed : null

    if (prev) {
      const dtSec = (t - prev.t) / 1000
      const metres = haversineKm(prev.lat, prev.lon, latitude, longitude) * 1000
      // Derive speed only when the platform withheld it and the interval is
      // long enough that GPS jitter isn't the dominant term.
      if (sample === null && dtSec >= 0.5) sample = metres / dtSec
      // A real step is needed for a meaningful bearing; below that the computed
      // angle is noise, so keep the previous heading.
      if (metres >= 20) {
        this._heading =
          typeof loc.heading === 'number' && loc.heading >= 0
            ? loc.heading
            : bearing(prev.lat, prev.lon, latitude, longitude)
      } else if (typeof loc.heading === 'number' && loc.heading >= 0) {
        this._heading = loc.heading
      }
    }

    this._lastFix = { lat: latitude, lon: longitude, t }

    if (sample === null) return
    this._speedMps = prev === null
      ? sample
      : this._speedMps + SPEED_SMOOTHING * (sample - this._speedMps)
    this._setMotion(classifyMotion(this._speedMps, this._motion))
  }
}
