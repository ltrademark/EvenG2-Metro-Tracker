import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { wmataClient } from './wmata'
import type { Station, Train } from './wmata'
import { GlassesDisplay } from './glasses'
import { LocationManager } from './location'
import { ImuController } from './imu'

export interface AppBridgeAdapter {
  setStations(stations: Station[]): void
  onStationChanged(station: Station, distKm: number): void
  onPredictionsUpdated(trains: Train[]): void
  onGpsPositionUpdated(lat: number, lon: number): void
  onStatusChanged(text: string): void
  onSplashTap(): void
  getIsPinned(): boolean
  getCurrentStationCode(): string | null
}

export interface BridgeControls {
  pinStation(code: string): void
  unpin(): void
  forceRefresh(): Promise<void>
  startLocation(): void
  destroy(): void
}

type BridgeWithBackgroundState = EvenAppBridge & {
  setBackgroundState?: (key: string, getter: () => unknown) => void
  onBackgroundRestore?: (key: string, handler: (data: unknown) => void) => void
}

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

function nearbyStations(
  stations: Station[],
  lat: number,
  lon: number,
  excludeCode: string,
  limit = 3,
): Station[] {
  if (!lat && !lon) return []
  return stations
    .filter(s => s.code !== excludeCode && s.secondaryCode !== excludeCode)
    .map(s => ({ s, d: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(x => x.s)
}

export async function initBridge(adapter: AppBridgeAdapter): Promise<BridgeControls> {
  const bridge = (await waitForEvenAppBridge()) as BridgeWithBackgroundState
  wmataClient.setBridge(bridge)

  adapter.onStatusChanged('Loading stations…')
  const stations = await wmataClient.loadStations()
  adapter.setStations(stations)

  const glassesDisplay = new GlassesDisplay(bridge)
  const ok = await glassesDisplay.startup()
  if (!ok) {
    console.error('createStartUpPageContainer failed — glasses may not be connected')
    adapter.onStatusChanged('Glasses not ready, retrying…')
    setTimeout(() => void glassesDisplay.startup(), 5000)
  }

  let currentStation: Station | null = null
  let currentDistKm = 0
  let userLat = 0
  let userLon = 0
  let nearby: Station[] = []
  let isPinned = false
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  async function doRefresh(goToTimetable = false) {
    if (!currentStation) return

    const trains = await wmataClient.fetchPredictions(currentStation)
    adapter.onPredictionsUpdated(trains)

    const view = glassesDisplay.view
    if (goToTimetable || view === 'timetable') {
      await glassesDisplay.showTimetable(currentStation, trains, currentDistKm)
    } else {
      await glassesDisplay.showStations(currentStation, nearby, currentDistKm)
    }

    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const distMi = (currentDistKm * 0.621371).toFixed(1)
    const errors = wmataClient.getConsecutiveErrors()
    adapter.onStatusChanged(
      errors > 0 ? `${timeStr}  ⚠ API error` : `${timeStr}  • ${distMi}mi`,
    )
  }

  function startTimer() {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(() => void doRefresh(), 30_000)
  }

  function stopTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  const locationManager = new LocationManager(
    stations,
    (station, distKm) => {
      if (isPinned) return
      currentStation = station
      currentDistKm = distKm
      nearby = nearbyStations(stations, userLat, userLon, station.code)
      adapter.onStationChanged(station, distKm)
      void doRefresh()
    },
    (lat, lon) => {
      userLat = lat
      userLon = lon
      adapter.onGpsPositionUpdated(lat, lon)
    },
  )

  const imuController = new ImuController(
    bridge,
    () => {
      if (currentStation) void doRefresh()
    },
    () => {},
  )

  // View-aware input routing
  bridge.onEvenHubEvent(event => {
    const sys = event.sysEvent as { eventType?: number } | undefined
    if (!sys) return
    const eventType = sys.eventType ?? -1

    switch (glassesDisplay.view) {
      case 'splash':
        if (eventType === 0) adapter.onSplashTap()
        break

      case 'stations':
        if (eventType === 0) {
          // Tap on station name → open timetable
          const trains = wmataClient.getLastPredictions()
          if (currentStation && trains.length > 0) {
            void glassesDisplay.showTimetable(currentStation, trains, currentDistKm)
          } else if (currentStation) {
            void doRefresh()
          }
        } else if (eventType === 3) {
          void bridge.shutDownPageContainer(1)
        } else if (eventType === 4) {
          startTimer()
          void doRefresh()
        } else if (eventType === 5) {
          stopTimer()
        }
        break

      case 'timetable':
        if (eventType === 0) {
          // Tap → toggle direction and refresh
          glassesDisplay.toggleTrainGroup()
          void glassesDisplay.refreshTimetable()
        } else if (eventType === 3) {
          // Double tap → back to station list
          if (currentStation) {
            void glassesDisplay.showStations(currentStation, nearby, currentDistKm)
          }
        } else if (eventType === 4) {
          startTimer()
          void doRefresh()
        } else if (eventType === 5) {
          stopTimer()
        }
        break
    }
  })

  try {
    bridge.setBackgroundState?.('state', () => ({
      stationCode: currentStation?.code ?? null,
      isPinned,
    }))
    bridge.onBackgroundRestore?.('state', (saved: unknown) => {
      const s = saved as { stationCode?: string; isPinned?: boolean }
      if (s.stationCode) {
        const station = wmataClient.getStationByCode(s.stationCode)
        if (station) {
          currentStation = station
          adapter.onStationChanged(station, 0)
        }
      }
      isPinned = s.isPinned ?? false
    })
  } catch {
    console.warn('Background state API not available in this SDK version')
  }

  try {
    await imuController.start()
  } catch {
    console.warn('IMU not available (not supported in simulator)')
  }

  if (import.meta.env.DEV && !currentStation) {
    const devStation = wmataClient.getStationByCode('A01')
    if (devStation) {
      currentStation = devStation
      currentDistKm = 0
      adapter.onStationChanged(devStation, 0)
      adapter.onStatusChanged('Dev: Metro Center (A01)')
    }
  }

  void doRefresh()
  startTimer()

  return {
    pinStation(code: string) {
      const station = wmataClient.getStationByCode(code)
      if (!station) return
      isPinned = true
      currentStation = station
      currentDistKm = 0
      nearby = nearbyStations(stations, station.lat, station.lon, station.code)
      adapter.onStationChanged(station, 0)
      void doRefresh(true)
    },
    unpin() {
      isPinned = false
    },
    async forceRefresh() {
      await doRefresh()
    },
    startLocation() {
      locationManager.start()
    },
    destroy() {
      stopTimer()
      imuController.stop()
      locationManager.stop()
    },
  }
}
