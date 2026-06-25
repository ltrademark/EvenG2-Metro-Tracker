import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
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

  async function doRefresh(goToTimetable = false, stationOverride?: Station) {
    const station = stationOverride ?? currentStation
    if (!station) return

    const trains = await wmataClient.fetchPredictions(station)
    adapter.onPredictionsUpdated(trains)

    const view = glassesDisplay.view
    if (goToTimetable || view === 'timetable') {
      await glassesDisplay.showTimetable(station, trains, currentDistKm)
    } else {
      await glassesDisplay.showStations(station, nearby, currentDistKm)
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
    refreshTimer = setInterval(() => {
      if (glassesDisplay.view !== 'splash') void doRefresh()
    }, 30_000)
  }

  function stopTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  const locationManager = new LocationManager(
    bridge,
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

  // View-aware input routing — follows docs pattern:
  // https://hub.evenrealities.com/docs/build/device-apis
  //
  // textEvent/listEvent: user interaction from rebuildPageContainer containers.
  // sysEvent: foreground lifecycle events AND interactions from createStartUpPageContainer.
  // CLICK_EVENT (0) may be normalised to undefined by the SDK — handle both.
  bridge.onEvenHubEvent(event => {
    const sys = event.sysEvent as { eventType?: number } | undefined
    const sysType = sys?.eventType as number | undefined

    // Foreground lifecycle — always sysEvent
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      startTimer(); void doRefresh(); return
    }
    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      stopTimer(); return
    }

    // Resolve event type: prefer textEvent/listEvent (docs pattern);
    // fall back to sysEvent for explicit press types (startup page + double-press).
    const userEvent = event.textEvent ?? event.listEvent
    let eventType: number | undefined
    if (userEvent) {
      eventType = userEvent.eventType as number | undefined
      // undefined here means CLICK_EVENT (SDK normalisation)
    } else if (
      sysType === OsEventTypeList.CLICK_EVENT ||
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      eventType = sysType
    } else {
      return
    }

    const isPress = eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined
    const isDoublePress = eventType === OsEventTypeList.DOUBLE_CLICK_EVENT
    if (!isPress && !isDoublePress) return

    switch (glassesDisplay.view) {
      case 'splash':
        if (isPress) {
          adapter.onSplashTap()
          if (currentStation) void doRefresh()
        }
        break

      case 'stations':
        if (isPress) {
          // Resolve which station the user scrolled to before pressing.
          // List order: [currentStation, ...nearby] — matches showStations item order.
          const idx = event.listEvent?.currentSelectItemIndex ?? 0
          const stationList = currentStation ? [currentStation, ...nearby] : nearby
          const selected = stationList[idx] ?? currentStation ?? undefined
          void doRefresh(true, selected)
        }
        break

      case 'timetable':
        if (isPress) {
          glassesDisplay.toggleTrainGroup()
          void glassesDisplay.refreshTimetable()
        } else if (isDoublePress) {
          if (currentStation) {
            void glassesDisplay.showStations(currentStation, nearby, currentDistKm)
          }
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
      nearby = nearbyStations(stations, devStation.lat, devStation.lon, devStation.code)
      adapter.onStationChanged(devStation, 0)
      adapter.onStatusChanged('Dev: Metro Center (A01)')
    }
  }

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
