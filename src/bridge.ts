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

// Bridge methods that may not exist in all SDK versions
type BridgeWithBackgroundState = EvenAppBridge & {
  setBackgroundState?: (key: string, getter: () => unknown) => void
  onBackgroundRestore?: (key: string, handler: (data: unknown) => void) => void
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
  let isPinned = false
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  async function doRefresh() {
    if (!currentStation) return
    await glassesDisplay.updateStatus('Refreshing…')
    const trains = await wmataClient.fetchPredictions(currentStation)
    adapter.onPredictionsUpdated(trains)
    await glassesDisplay.render(currentStation, trains, currentDistKm, new Date())

    const errors = wmataClient.getConsecutiveErrors()
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const distMi = (currentDistKm * 0.621371).toFixed(1)
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
      adapter.onStationChanged(station, distKm)
      void doRefresh()
    },
    (lat, lon) => adapter.onGpsPositionUpdated(lat, lon),
  )

  const imuController = new ImuController(
    bridge,
    () => {
      if (currentStation) void doRefresh()
    },
    () => {}, // head-down: no-op for now
  )

  // Input event routing
  bridge.onEvenHubEvent(event => {
    const sys = event.sysEvent as { eventType?: number } | undefined
    if (!sys) return
    const eventType = sys.eventType ?? -1

    switch (eventType) {
      case 0: // single tap → force refresh
        void doRefresh()
        break
      case 3: // double tap → exit dialog
        void bridge.shutDownPageContainer(1)
        break
      case 4: // foreground enter → resume
        startTimer()
        void doRefresh()
        break
      case 5: // foreground exit → pause
        stopTimer()
        break
    }
  })

  // Background state persistence (optional SDK feature)
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
  // Dev mode: auto-pin Metro Center so the simulator shows real data immediately
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
      adapter.onStationChanged(station, 0)
      void doRefresh()
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
