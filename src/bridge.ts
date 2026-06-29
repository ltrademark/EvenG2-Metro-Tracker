import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { wmataClient } from './wmata'
import type { Station, Train } from './wmata'
import { GlassesDisplay } from './glasses'
import { LocationManager } from './location'

export interface AppBridgeAdapter {
  setStations(stations: Station[]): void
  onStationChanged(station: Station, distKm: number): void
  onDistanceChanged(distKm: number): void
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
  limit = 7,
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
  let viewedStation: Station | null = null   // station whose board is shown in the timetable
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  async function doRefresh(goToTimetable = false, stationOverride?: Station) {
    if (!currentStation) return

    // In the timetable we display the station the user selected, and keep
    // displaying it across auto-refreshes — not the home station.
    const inTimetable = goToTimetable || glassesDisplay.view === 'timetable'
    if (stationOverride) viewedStation = stationOverride
    const station = inTimetable ? (viewedStation ?? currentStation) : currentStation

    const trains = await wmataClient.fetchPredictions(station)
    adapter.onPredictionsUpdated(trains)

    // Single source of truth for what both UIs display: the focused station,
    // its distance from the user, and whether it was manually chosen.
    const hasGps = userLat !== 0 || userLon !== 0
    currentDistKm = hasGps ? haversineKm(userLat, userLon, station.lat, station.lon) : 0
    const selected = isPinned || (!!viewedStation && viewedStation.code !== currentStation.code)
    adapter.onStationChanged(station, currentDistKm, selected)

    const locationOn = !isPinned
    if (inTimetable) {
      await glassesDisplay.showTimetable(station, trains, currentDistKm, currentStation, nearby, locationOn)
    } else {
      await glassesDisplay.showStations(currentStation, nearby, currentDistKm, locationOn)
    }
  }

  // Persist the home station across sessions so returning users land on their
  // board immediately instead of waiting on a launch screen.
  function persistStation() {
    if (currentStation) void bridge.setLocalStorage('lastStation', currentStation.code)
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
    (station) => {
      if (isPinned) return
      currentStation = station
      nearby = nearbyStations(stations, userLat, userLon, station.code)
      persistStation()
      void doRefresh()   // doRefresh notifies both UIs of the focused station
    },
    (lat, lon) => {
      userLat = lat
      userLon = lon
      adapter.onGpsPositionUpdated(lat, lon)
      // Keep the distance to the focused station (current or selected) live as
      // the user moves, between full refreshes.
      const focused = viewedStation ?? currentStation
      if (focused) {
        currentDistKm = haversineKm(lat, lon, focused.lat, focused.lon)
        adapter.onDistanceChanged(currentDistKm)
      }
    },
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
    } else if (sys) {
      // sysEvent-only (startup page or double-press).
      // SDK may normalise CLICK_EVENT=0 to undefined on real hardware — treat that as a click.
      // FOREGROUND_ENTER/EXIT are already handled above, so undefined here is safe to treat as click.
      if (
        sysType === OsEventTypeList.CLICK_EVENT ||
        sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        sysType === undefined
      ) {
        eventType = sysType
      } else {
        return
      }
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
            viewedStation = null
            void glassesDisplay.showStations(currentStation, nearby, currentDistKm, !isPinned)
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
      isPinned = s.isPinned ?? false
      if (s.stationCode) {
        const station = wmataClient.getStationByCode(s.stationCode)
        if (station) {
          currentStation = station
          adapter.onStationChanged(station, 0, isPinned)
        }
      }
    })
  } catch {
    console.warn('Background state API not available in this SDK version')
  }

  // Returning users: restore the last station so the board appears immediately,
  // before GPS locks. The WebView already remembers the location permission, so
  // location resumes without a prompt and refines this to the nearest station.
  if (!currentStation) {
    try {
      const lastCode = await bridge.getLocalStorage('lastStation')
      if (lastCode) {
        const station = wmataClient.getStationByCode(lastCode)
        if (station) {
          currentStation = station
          nearby = nearbyStations(stations, station.lat, station.lon, station.code)
          void doRefresh()   // doRefresh notifies both UIs
        }
      }
    } catch { /* nothing persisted yet */ }
  }

  if (import.meta.env.DEV && !currentStation) {
    const devStation = wmataClient.getStationByCode('A01')
    if (devStation) {
      currentStation = devStation
      currentDistKm = 0
      nearby = nearbyStations(stations, devStation.lat, devStation.lon, devStation.code)
      adapter.onStationChanged(devStation, 0, false)
      adapter.onStatusChanged('Dev: Metro Center (A01)')
    }
  }

  startTimer()

  return {
    pinStation(code: string) {
      const station = wmataClient.getStationByCode(code)
      if (!station) return
      isPinned = true            // manual pin → "location off" icon
      viewedStation = null
      currentStation = station
      nearby = nearbyStations(stations, station.lat, station.lon, station.code)
      persistStation()
      void doRefresh()  // doRefresh computes distance + notifies both UIs
    },
    unpin() {
      isPinned = false           // "Auto" → re-lock to GPS, "location on" icon
      viewedStation = null
      // Snap back to the GPS-nearest station so both UIs reflect the change
      // immediately instead of waiting for the next location update.
      if (userLat !== 0 || userLon !== 0) {
        let nearest: Station | null = null
        let best = Infinity
        for (const s of stations) {
          const d = haversineKm(userLat, userLon, s.lat, s.lon)
          if (d < best) { best = d; nearest = s }
        }
        if (nearest) {
          currentStation = nearest
          nearby = nearbyStations(stations, userLat, userLon, nearest.code)
        }
      }
      persistStation()
      void doRefresh()
    },
    async forceRefresh() {
      await doRefresh()
    },
    startLocation() {
      locationManager.start()
    },
    destroy() {
      stopTimer()
      locationManager.stop()
    },
  }
}
