import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { wmataClient } from './wmata'
import type { Station, Train } from './wmata'
import { GlassesDisplay } from './glasses'
import type { GlassesView } from './glasses'
import { LocationManager } from './location'
import { LiveStripController, chooseLineAndDirection } from './live'

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

// Identity of a station as a *place* rather than as a platform.
//
// WMATA lists a dual-platform interchange once per platform: Gallery Pl-Chinatown
// is both B01 (with F01 as its secondary) and F01 (with B01 as its secondary). The
// two entries sit metres apart, so a distance sort puts them side by side and the
// same name appears twice in the list. Keying on the sorted pair of codes gives
// both entries the same identity regardless of which one we happen to meet first.
function stationKey(s: Station): string {
  return s.secondaryCode ? [s.code, s.secondaryCode].sort().join('+') : s.code
}

function nearbyStations(
  stations: Station[],
  lat: number,
  lon: number,
  excludeCode: string,
  limit = 7,
): Station[] {
  if (!lat && !lon) return []
  const seen = new Set<string>()
  return stations
    .filter(s => s.code !== excludeCode && s.secondaryCode !== excludeCode)
    .map(s => ({ s, d: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    // Deduplicate after sorting so the platform we keep is the nearer of the pair,
    // and before slicing so a collapsed duplicate doesn't cost a list slot.
    .filter(x => {
      const key = stationKey(x.s)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map(x => x.s)
}

// The stops ahead of `current`, in the order they'll be reached.
//
// Ordering by raw distance puts stations *behind* the train in the list simply
// because they're still close. Walking the line's own station sequence in the
// direction of travel gives the upcoming-stops view instead.
//
// Returns null when there's no confident answer — no route geometry loaded yet,
// current station absent from the sequence, a heading that doesn't align with
// either direction, or nothing ahead (a terminus pointing off the end of its own
// line). Callers fall back to distance ordering.
// Exported so the ordering can be exercised against real WMATA route topology
// without standing up the whole bridge.
export function journeyStations(current: Station, heading: number, limit = 7): Station[] | null {
  const chosen = chooseLineAndDirection(current, heading)
  if (!chosen) return null

  const ownCodes = new Set(
    [current.code, current.secondaryCode].filter((c): c is string => c != null),
  )
  const seq = wmataClient.getLineStationCodes(chosen.line)
  const here = seq.findIndex(c => ownCodes.has(c))
  if (here < 0) return null

  const ahead: Station[] = []
  for (let i = here + chosen.step; i >= 0 && i < seq.length && ahead.length < limit; i += chosen.step) {
    const station = wmataClient.getStationByCode(seq[i])
    if (!station) continue
    if (ownCodes.has(station.code)) continue
    if (ahead.some(s => s.code === station.code)) continue
    ahead.push(station)
  }

  return ahead.length ? ahead : null
}

export async function initBridge(adapter: AppBridgeAdapter): Promise<BridgeControls> {
  const bridge = (await waitForEvenAppBridge()) as BridgeWithBackgroundState
  wmataClient.setBridge(bridge)

  adapter.onStatusChanged('Loading stations…')
  const stations = await wmataClient.loadStations()
  adapter.setStations(stations)

  // The live strip needs the circuit→route model, and until now it was loaded
  // only by the web app after initBridge resolved — so whether it existed at
  // first render was a race. Firing it here is not awaited (the station list must
  // not wait on it) and is idempotent with a 24h cache, so the web app's own call
  // later costs nothing. A failure is a state the strip renders, not a throw.
  let routesFailed = false
  void wmataClient.loadStandardRoutes().catch(err => {
    routesFailed = true
    console.error('Route model load failed:', err)
  })

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
  // Which view the user has *asked* for, as opposed to what's currently drawn
  // (glassesDisplay.view). Set synchronously the moment an input arrives, so a
  // tap can't be undone by an auto-refresh that started before it: renders are
  // decided against this after their network await, not against stale state.
  let viewIntent: Exclude<GlassesView, 'splash'> = 'stations'
  // Where dismissing the live strip returns to. It is an overlay rather than a
  // destination, so it restores whatever was underneath instead of always
  // assuming the timetable.
  let liveReturnView: 'stations' | 'timetable' = 'timetable'
  // Signature of the landing list ([current, ...nearby]). While it's unchanged
  // we refresh only the status text in place, never rebuilding the list — that
  // keeps the native selection cursor from jumping on periodic refreshes.
  //
  // The "what's on screen" side of this comparison lives in GlassesDisplay and
  // only advances after a rebuild actually lands. Tracking it here instead meant
  // committing the new signature before the render, so a dropped or failed
  // render was mistaken for a completed one and the list silently stayed stale.
  const stationsSig = () => `${currentStation?.code ?? ''}|${nearby.map(s => s.code).join(',')}`

  async function doRefresh(goToTimetable = false, stationOverride?: Station) {
    if (!currentStation) return

    if (goToTimetable) viewIntent = 'timetable'
    if (stationOverride) viewedStation = stationOverride

    // In the timetable we display the station the user selected, and keep
    // displaying it across auto-refreshes — not the home station. The live strip
    // keeps that same focus, so revealing it doesn't quietly move the phone UI
    // (or the distance readout) back to the home station and then leave it there.
    const focused = () =>
      viewIntent === 'stations' ? currentStation! : (viewedStation ?? currentStation!)

    const trains = await wmataClient.fetchPredictions(focused())

    // Re-read the intent *after* the await. A tap (or a back gesture) that
    // arrived while predictions were in flight must win over what this refresh
    // originally set out to draw — otherwise a timer tick that started first
    // would repaint the station list over the timetable the tap just opened.
    const intent = viewIntent
    const station = focused()

    adapter.onPredictionsUpdated(trains)

    // Single source of truth for what both UIs display: the focused station,
    // its distance from the user, and whether it was manually chosen.
    const hasGps = userLat !== 0 || userLon !== 0
    currentDistKm = hasGps ? haversineKm(userLat, userLon, station.lat, station.lon) : 0
    const selected = isPinned || (!!viewedStation && viewedStation.code !== currentStation.code)
    adapter.onStationChanged(station, currentDistKm, selected)

    const locationOn = !isPinned
    if (intent === 'liveview') {
      // The strip runs its own faster timer; this branch exists so the 30s tick
      // keeps the clock moving without repainting the view underneath. renderLive
      // writes only what changed, so a tick within the same minute costs nothing,
      // and it rebuilds by itself if the containers were invalidated meanwhile.
      renderLiveStrip()
    } else if (intent === 'timetable') {
      await glassesDisplay.showTimetable(station, trains, currentDistKm, currentStation, nearby, locationOn)
    } else {
      // Landing view: only rebuild the list when its contents actually change
      // (nearest station / nearby set). Otherwise just refresh the status line
      // in place so the selection cursor stays put across periodic refreshes.
      const sig = stationsSig()
      if (glassesDisplay.view === 'stations' && sig === glassesDisplay.renderedStationsSig) {
        await glassesDisplay.updateStatus(currentDistKm)
      } else {
        await glassesDisplay.showStations(currentStation, nearby, currentDistKm, locationOn, sig)
      }
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

  // Upcoming stops while riding, nearest stops otherwise. Journey ordering needs
  // route geometry (loaded by the web app on mount) and a confident heading, so
  // every unmet precondition falls through to the distance-based list.
  function listForStation(station: Station): Station[] {
    if (locationManager?.motion === 'transit') {
      const heading = locationManager.heading
      if (heading !== null) {
        const journey = journeyStations(station, heading)
        if (journey) return journey
      }
    }
    return nearbyStations(stations, userLat, userLon, station.code)
  }

  const locationManager = new LocationManager(
    bridge,
    stations,
    (station) => {
      if (isPinned) return
      currentStation = station
      nearby = listForStation(station)
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
    (motion) => {
      // Boarding or alighting changes both the badge and what the list should
      // show, so refresh rather than waiting up to 30s for the next tick.
      glassesDisplay.setInTransit(motion === 'transit')
      // The live view's in-transit badge is an image push, and an image can't be
      // un-pushed in place, so clearing it needs a rebuild. Motion changes only on
      // boarding or alighting, so this is rare enough to be worth the rebuild.
      if (viewIntent === 'liveview') glassesDisplay.invalidateLive()
      if (!isPinned && currentStation) nearby = listForStation(currentStation)
      void doRefresh()
    },
  )

  // ── Live strip ─────────────────────────────────────────────────────────
  //
  // A transient overlay, not a destination: it runs its own faster timer while
  // visible and is torn down the moment it isn't, so nothing ever polls for a
  // view that's off screen.

  // The station the strip is drawn around: whatever the timetable is showing, since
  // the strip stands in for that panel. Falls back to the rider's own station, which
  // is what the landing view and a fresh reveal both mean.
  const liveAnchor = () => viewedStation ?? currentStation

  const liveController = new LiveStripController(
    () => ({
      station: liveAnchor(),
      atOwnStation: !viewedStation || viewedStation.code === currentStation?.code,
      lat: userLat,
      lon: userLon,
      heading: locationManager.heading,
      routesFailed,
    }),
    () => renderLiveStrip(),
  )

  function renderLiveStrip() {
    const anchor = liveAnchor()
    if (viewIntent !== 'liveview' || !currentStation || !anchor) return
    // The left list stays anchored on the home station in the same frozen order as
    // every other view, with the browsed station marked — exactly what the timetable
    // does, so the two panels never disagree about which station is in focus.
    void glassesDisplay.renderLive(
      liveController.model(), currentStation, nearby, anchor.code, currentDistKm, !isPinned,
    )
  }

  // Revealed from inside the bridge only: the scroll stand-in below in DEV, and
  // the head-tilt gesture once that lands. Nothing outside needs to trigger it,
  // so it is deliberately not on BridgeControls.
  function showLive() {
    if (!currentStation || viewIntent === 'liveview') return
    liveReturnView = viewIntent
    // Recorded before the render, exactly like a tap, so a refresh already in
    // flight draws the strip rather than the view it is replacing.
    viewIntent = 'liveview'
    liveController.start()   // latches direction, then renders immediately
  }

  function hideLive() {
    if (viewIntent !== 'liveview') return
    liveController.stop()
    viewIntent = liveReturnView
    void doRefresh()
  }

  // View-aware input routing — follows docs pattern:
  // https://hub.evenrealities.com/docs/build/device-apis
  //
  // textEvent/listEvent: user interaction from rebuildPageContainer containers.
  // sysEvent: foreground lifecycle events AND interactions from createStartUpPageContainer.
  // CLICK_EVENT (0) may be normalised to undefined by the SDK — handle both.
  const unsubscribeEvents = bridge.onEvenHubEvent(event => {
    const sys = event.sysEvent as { eventType?: number } | undefined
    const sysType = sys?.eventType as number | undefined

    // Foreground lifecycle — always sysEvent
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      // Recovery hatch: if a render ever wedges the queue, returning to the
      // foreground clears it so the UI is usable again without a full restart.
      glassesDisplay.resetRenderLock()
      // The OS may have torn the page down while backgrounded, so the live
      // containers can't be upgraded in place until they've been rebuilt once.
      glassesDisplay.invalidateLive()
      startTimer(); void doRefresh(); return
    }
    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      stopTimer(); liveController.stop(); return
    }
    // OS is tearing down the plugin — release resources before it terminates.
    if (
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      stopTimer()
      liveController.stop()
      locationManager.stop()
      return
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

    // DEV only. Scroll stands in for the head tilt, because the simulator has no
    // head to tilt and its automation API sends glasses input only, so the web
    // app's own debug button is out of reach from a test. Scroll is unused in both
    // views this touches: the timetable's lists are display-only, and the strip
    // has nothing to scroll. Inside the strip it also nudges the position, which
    // is the only way to sweep it for screenshots given the location API is absent
    // there too, so the strip would otherwise never move.
    if (import.meta.env.DEV) {
      const up = eventType === OsEventTypeList.SCROLL_TOP_EVENT
      const down = eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT
      if (glassesDisplay.view === 'timetable' && up) {
        showLive()
        return
      }
      if (glassesDisplay.view === 'liveview' && (up || down)) {
        liveController.devScrub(down ? 0.25 : -0.25)
        renderLiveStrip()
        return
      }
    }

    const isPress = eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined
    const isDoublePress = eventType === OsEventTypeList.DOUBLE_CLICK_EVENT
    if (!isPress && !isDoublePress) return

    switch (glassesDisplay.view) {
      case 'splash':
        if (isPress) {
          viewIntent = 'stations'
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
        } else if (isDoublePress) {
          // Top-level back gesture exits the plugin. Mode 1 pops the OS exit
          // layer; on confirm the SYSTEM_EXIT handler above runs cleanup and
          // the page container is shut down before termination.
          void bridge.shutDownPageContainer(1)
        }
        break

      case 'timetable':
        if (isPress) {
          glassesDisplay.toggleTrainGroup()
          void glassesDisplay.refreshTimetable()
        } else if (isDoublePress) {
          if (currentStation) {
            // Record the back gesture before rendering, so an auto-refresh
            // already in flight repaints the list rather than the timetable.
            viewIntent = 'stations'
            viewedStation = null
            // Passing the signature lets the next timer tick take the light
            // status-only path — but only once this rebuild actually lands.
            void glassesDisplay.showStations(currentStation, nearby, currentDistKm, !isPinned, stationsSig())
          }
        }
        break

      case 'liveview':
        if (isPress) {
          // The heading can only guess the direction, and can't guess at all while
          // standing still, so a press reverses the strip.
          liveController.flipDirection()
          renderLiveStrip()
        } else if (isDoublePress) {
          hideLive()
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
      liveController.stop()
      locationManager.stop()
      unsubscribeEvents()
    },
  }
}
