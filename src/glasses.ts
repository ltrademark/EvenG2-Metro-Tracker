import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type {
  EvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { Station, Train } from './wmata'
import { APP_VERSION } from './version'

export type GlassesView = 'splash' | 'stations' | 'timetable'

const W = 576      // display width
const LH = 27      // fixed line height on G2

const LOGO_URL = '/icons/logo_icon_large.png'
const LOGO_W = 144
const LOGO_H = 144

// Location indicator (bottom-left). on = GPS auto, off = manual pin.
const LOCATION_ON_URL  = '/icons/Location on.png'
const LOCATION_OFF_URL = '/icons/Location off.png'
const LOC_SIZE = 24
const LOC_X = 8
const LOC_Y = 257

// Hardware renders text a little wider than the simulator/pretext predicts, so
// every text budget keeps this much slack to truncate cleanly instead of
// wrapping onto a second line.
const SAFE = 18
const ITEM_INSET = 12   // list-item internal padding (approx, hardware)

// Left station-list box — identical geometry in both views so nothing shifts.
const LIST_X      = 4
const LIST_W      = 196
const LIST_BW     = 2
const LIST_RADIUS = 4
// Landing-view selection cursor. LIST_PAD insets the highlight from the panel's
// left edge; itemWidth caps its width to keep a matching gap on the right — so
// the cursor floats inside the panel with comfortable, symmetric padding.
const LIST_PAD    = 6
const LIST_ITEM_W = 180   // selection-border width (≈7px gap each side inside the panel)
const LIST_NAME_W = LIST_W - LIST_BW * 2 - ITEM_INSET - SAFE - LIST_PAD * 2   // name truncation budget

const ROW_PITCH    = 40   // measured G2 list item pitch (taller than text LH)
const MAX_VISIBLE  = 5    // station rows that fit above the bottom status row
const MAX_STATIONS = 8    // current + up to 7 nearby (scrollable on landing)
const MAX_TRAINS   = 4    // arrival rows that fit inside the panel

// Timetable right panel (arrivals)
const PANEL_X  = 210
const PANEL_W  = W - PANEL_X - 4   // 362
const PANEL_BW = 2
const PANEL_IX = PANEL_X + 20      // 20px horizontal padding from outer border
const PANEL_IW = PANEL_W - 40      // 322

// ── Bridge-call timeouts ───────────────────────────────────────────────────
//
// Every bridge call is a BLE round-trip to the glasses and can stall
// indefinitely — a stressed radio (crowded train, phone in a pocket) is enough.
// An unbounded await inside the render lock used to wedge the whole display
// permanently: the lock was never released, so every later render early-returned
// and taps stopped doing anything while on-device list scrolling kept working.
// Bounding each call means a stall surfaces as a rejection we can recover from.
const BRIDGE_TIMEOUT_MS = 5_000

function withTimeout<T>(p: Promise<T>, label: string, ms = BRIDGE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

// ── Container helpers ──────────────────────────────────────────────────────

function img(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
): ImageContainerProperty {
  return { containerID: id, containerName: name, xPosition: x, yPosition: y, width: w, height: h }
}

function txt(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
  content: string,
  isEvent = false,
  borderWidth = 0,
  borderRadius = 0,
): TextContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    content,
    borderWidth, borderColor: 15, borderRadius,
    paddingLength: 0,
    isEventCapture: isEvent ? 1 : 0,
  }
}

function lst(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
  items: string[],
  isEvent = false,
  borderWidth = 0,
  borderRadius = 0,
  selectBorder = false,
  padding = 0,
  itemWidth = 0,
): ListContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    isEventCapture: isEvent ? 1 : 0,
    borderWidth, borderColor: 15, borderRadius, paddingLength: padding,
    itemContainer: { itemCount: items.length, itemName: items, itemWidth, isItemSelectBorderEn: selectBorder ? 1 : 0 },
  }
}

function clock(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

// Bottom-right status: distance + clock, e.g. "0.1mi • 2:45 PM". The distance
// is dropped when it would read 0.0 (at the station) or there's no GPS fix.
function statusStr(distKm: number): string {
  const mi = distKm * 0.621371
  const clk = clock()
  return mi >= 0.05 ? `${mi.toFixed(1)}mi • ${clk}` : clk
}

function fmtMin(min: string): string {
  if (min === 'ARR') return 'ARR'
  if (min === 'BRD') return 'BRD'
  return min   // numeric minutes, no "m" suffix
}

// ── Pixel-accurate table columns ───────────────────────────────────────────
//
// Each column target is content + trailing gap, so cells butt together cleanly.
// Computed once at module load — getTextWidth is a pure sync function.

const SPACE_W = getTextWidth(' ')
const COL_LN  = getTextWidth('LANE') + 12   // header word is wider than "BL"/"YL"
const COL_CAR = getTextWidth('CAR') + 12    // header word is wider than "6"/"8"
const COL_MIN = getTextWidth('ARR') + 12    // "ARR"/"BRD" widest; numbers fit easily

// The arrivals list is PANEL_IW+6 wide (x shifted -6 to align under headers).
// Keep the whole row string well under that so MIN never wraps on hardware.
const ROW_BUDGET = PANEL_IW + 6 - ITEM_INSET - SAFE
const COL_DEST   = ROW_BUDGET - COL_LN - COL_CAR - COL_MIN

function padCol(text: string, targetPx: number): string {
  const w = getTextWidth(text)
  if (w >= targetPx) return pxTruncate(text, targetPx)
  return text + ' '.repeat(Math.max(1, Math.round((targetPx - w) / SPACE_W)))
}

// Column header built once; same column widths as data rows.
const TABLE_HEADER =
  padCol('LANE', COL_LN) +
  padCol('CAR', COL_CAR) +
  padCol('DESTINATION', COL_DEST) +
  'MIN'

function fmtTrainRow(train: Train): string {
  return (
    padCol(train.line, COL_LN) +
    padCol(train.car, COL_CAR) +
    padCol(pxTruncate(train.destination.toUpperCase(), COL_DEST - 4), COL_DEST) +
    fmtMin(train.min)
  )
}

// ── Main display class ─────────────────────────────────────────────────────

// "> " marker for the selected station in the TIMETABLE only — it intentionally
// shifts that row's text right for visual distinction. On the LANDING view no
// row is marked (the native selection cursor shows focus instead), so names sit
// flush-left and use the full row width.
const MARK_PREFIX = '> '
const MARK_W      = getTextWidth(MARK_PREFIX)

// Direction switcher — its own small container at the panel's right edge, so it
// can never wrap into the destination text. Single press toggles direction.
const SWITCH_LABEL = '< >'
const SWITCH_W     = getTextWidth(SWITCH_LABEL)
const SWITCH_BOX_W = SWITCH_W + 12
const SWITCH_X     = PANEL_IX + PANEL_IW - SWITCH_BOX_W
const DEST_HDR_W   = PANEL_IW - SWITCH_BOX_W - 8   // destination header container width

// Frozen-order list: [current, ...nearby]. The order never changes between the
// list view and the timetable view. When `showMarker` is set (timetable), the
// marked station is prefixed with "> " and its name budget is reduced by that
// width so the shifted row can't overflow; every other row is flush-left at the
// full width. On the landing view `showMarker` is false → no prefixes at all.
// Station names keep their natural Title Case (narrower than ALL CAPS).
function stationItems(
  current: Station, nearby: Station[], markedCode: string, showMarker: boolean,
): string[] {
  const fmt = (s: Station) => {
    const marked = showMarker && s.code === markedCode
    const budget = marked ? LIST_NAME_W - MARK_W : LIST_NAME_W
    return `${marked ? MARK_PREFIX : ''}${pxTruncate(s.name, budget)}`
  }
  const items = [fmt(current)]
  if (nearby.length > 0) {
    for (const s of nearby.slice(0, MAX_STATIONS - 1)) items.push(fmt(s))
  } else {
    items.push('Searching...')
  }
  return items
}

export class GlassesDisplay {
  private _bridge: EvenAppBridge
  private _rendering = false
  private _pending: (() => Promise<void>) | null = null
  // Signature of the station list actually on screen. Only advanced after a
  // successful rebuild, so a dropped or failed render is always retried rather
  // than being mistaken for "already drawn".
  private _renderedStationsSig = ''
  private _view: GlassesView = 'splash'
  private _trainGroup: '1' | '2' = '1'
  private _timetableStation: Station | null = null
  private _timetableCurrentStation: Station | null = null
  private _timetableNearby: Station[] = []
  private _timetableTrains: Train[] = []
  private _timetableDistKm = 0
  private _timetableLocationOn = true
  private _statusDistKm = 0
  private _imgCache = new Map<string, number[]>()

  constructor(bridge: EvenAppBridge) {
    this._bridge = bridge
  }

  // ── Render queue ───────────────────────────────────────────────────────
  //
  // Renders are serialised (concurrent rebuilds would interleave on the wire),
  // but a render arriving mid-flight is *queued*, not dropped. Latest wins:
  // every task redraws the current state from scratch, so a newer request
  // supersedes a waiting one. This is what makes a tap that lands during an
  // auto-refresh still open the timetable instead of being silently swallowed.
  //
  // `_rendering` is set immediately before the try and cleared in its finally,
  // so it is released on every path — including a timeout or a throw in the
  // layout maths. Nothing may await between the assignment and the try.
  private async _enqueue(task: () => Promise<void>): Promise<void> {
    this._pending = task
    if (this._rendering) return   // an active drain will pick it up
    this._rendering = true
    try {
      while (this._pending) {
        const next = this._pending
        this._pending = null
        try {
          await next()
        } catch (err) {
          // One failed render must not abort the drain or leak the lock.
          console.error('Glasses render failed:', err)
        }
      }
    } finally {
      this._rendering = false
    }
  }

  // Recovery hatch, called when the app returns to the foreground. With the
  // queue above the lock should never stick, but clearing it costs nothing and
  // guarantees a background/foreground cycle always restores a usable UI.
  resetRenderLock(): void {
    this._rendering = false
    this._pending = null
  }

  get renderedStationsSig(): string {
    return this._renderedStationsSig
  }

  private async _fetchImg(url: string): Promise<number[]> {
    const cached = this._imgCache.get(url)
    if (cached) return cached
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`Image fetch ${url}: ${res.status}`)
      const bytes = Array.from(new Uint8Array(await res.arrayBuffer()))
      this._imgCache.set(url, bytes)
      return bytes
    } finally {
      clearTimeout(timer)
    }
  }

  // Push the on/off location icon into a freshly-rebuilt image container.
  // Re-pushed on every rebuild because rebuildPageContainer recreates containers.
  private async _pushLocationIcon(id: number, on: boolean): Promise<void> {
    const url = on ? LOCATION_ON_URL : LOCATION_OFF_URL
    try {
      const bytes = await this._fetchImg(url)
      await withTimeout(
        this._bridge.updateImageRawData({ containerID: id, containerName: 'loc', imageData: bytes }),
        'updateImageRawData(loc)',
      )
    } catch (err) {
      console.warn('Location icon load failed:', err)
    }
  }

  get view(): GlassesView {
    return this._view
  }

  // ── Splash ─────────────────────────────────────────────────────────────
  //
  //   ID 1 — logo image            centered horizontally
  //   ID 2 — version (e.g. "v0.6.1") top-left (left-anchored so it never overflows)
  //   ID 3 — "METRO TRACKER"       below logo
  //   ID 4 — "Waiting for location…"  CTA (splash auto-dismisses on GPS lock)

  private _splashText(): TextContainerProperty[] {
    const cta = 'Waiting for location...'
    const ctaW = getTextWidth(cta)
    const titleW = getTextWidth('METRO TRACKER')
    return [
      txt(2, 'ver',   8, 6, 120, LH, `v${APP_VERSION}`),
      txt(3, 'title', Math.round((W - titleW) / 2), 172, titleW + 4, LH, 'METRO TRACKER'),
      txt(4, 'cta',   Math.round((W - ctaW) / 2),   218, ctaW + 4,   LH, cta, true),
    ]
  }

  async startup(): Promise<boolean> {
    const logoX = Math.round((W - LOGO_W) / 2)

    // createStartUpPageContainer is required before any hardware feature, but
    // hardware does NOT render images on the startup container. We still declare
    // the logo container here (keeps IDs 1–4 stable) — it just stays blank…
    // Bounded like every other bridge call: without a timeout a stalled BLE
    // link here hangs initBridge forever and the app never finishes starting.
    // A rejection instead lets the caller's retry path take over.
    let result: number
    try {
      result = await withTimeout(
        this._bridge.createStartUpPageContainer({
          containerTotalNum: 4,
          imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
          textObject: this._splashText(),
        }),
        'createStartUpPageContainer',
      )
    } catch (err) {
      console.error('createStartUpPageContainer failed:', err)
      return false
    }
    this._view = 'splash'

    // …then rebuild the same page with the logo. Rebuild-based images DO render
    // on hardware (same path as the location icon), so this is what makes the
    // logo appear on real glasses.
    let logoBytes: number[] | null = null
    try {
      logoBytes = await this._fetchImg(LOGO_URL)
    } catch (err) {
      console.warn('Logo prefetch failed:', err)
    }
    try {
      await withTimeout(
        this._bridge.rebuildPageContainer({
          containerTotalNum: 4,
          imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
          textObject: this._splashText(),
        }),
        'rebuildPageContainer(splash)',
      )
      if (logoBytes) {
        await withTimeout(
          this._bridge.updateImageRawData({ containerID: 1, containerName: 'logo', imageData: logoBytes }),
          'updateImageRawData(logo)',
        )
      }
    } catch (err) {
      console.warn('Splash logo render failed:', err)
    }

    return result === 0
  }

  // ── Station list ───────────────────────────────────────────────────────
  //
  //   ID 1 — station list (own border = the box), up to 8, isEventCapture
  //   ID 2 — status (distance + clock), bottom-right
  //   ID 3 — location icon, bottom-left

  async showStations(
    currentStation: Station,
    nearbyStations: Station[],
    distKm: number,
    locationOn = true,
    sig = '',
  ): Promise<void> {
    return this._enqueue(async () => {
      this._statusDistKm = distKm

      const items = stationItems(currentStation, nearbyStations, currentStation.code, false)
      const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10

      const status = statusStr(distKm)
      const statusW = getTextWidth(status)
      const statusX = W - 4 - statusW

      await withTimeout(
        this._bridge.rebuildPageContainer({
          containerTotalNum: 3,
          imageObject: [img(3, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)],
          textObject: [
            txt(2, 'clock', statusX, 258, statusW + 4, LH, status),
          ],
          // Landing list: near-full-width selection cursor (itemWidth), no marker.
          listObject: [lst(1, 'stations', LIST_X, 4, LIST_W, listH, items, true, LIST_BW, LIST_RADIUS, true, LIST_PAD, LIST_ITEM_W)],
        }),
        'rebuildPageContainer(stations)',
      )
      // Past this point the page is on screen — safe to claim the view. On a
      // failed rebuild we deliberately leave `_view` alone: input keeps routing
      // to whatever is actually displayed, so the next tap retries instead of
      // acting on a screen the user can't see.
      this._view = 'stations'
      this._renderedStationsSig = sig
      await this._pushLocationIcon(3, locationOn)
    })
  }

  // ── Timetable ──────────────────────────────────────────────────────────
  //
  // Left: the station list (own border = the box, same geometry as the landing
  // view so nothing shifts). Right: bordered arrivals panel.
  //
  //   ID 1 — station list (left, bordered, display-only)
  //   ID 2 — panel frame
  //   ID 3 — destination header   (isEventCapture — tap toggles direction)
  //   ID 4 — "< >" switcher        (own container at right edge, no wrap)
  //   ID 5 — divider line under the header
  //   ID 6 — table column header  "LANE CAR DESTINATION MIN"
  //   ID 7 — arrivals list (display-only)
  //   ID 8 — status (distance + clock), bottom-right
  //   ID 9 — location icon, bottom-left
  //
  // Vertical layout inside the panel (frame y=4, h=252):
  //   y=12:  destination header / switcher (centered above the divider)
  //   y=46:  divider
  //   y=54:  table column header
  //   y=84:  arrivals list (4 rows × 40px pitch = 160, ends ~y=250)

  async showTimetable(
    station: Station,            // the viewed station (board shown on the right)
    trains: Train[],
    distKm: number,
    currentStation: Station,     // home station — anchors the frozen left list
    nearbyStations: Station[] = [],
    locationOn = true,
  ): Promise<void> {
    return this._enqueue(async () => {
    this._timetableStation = station
    this._timetableCurrentStation = currentStation
    this._timetableNearby = nearbyStations
    this._timetableTrains = trains
    this._timetableDistKm = distKm
    this._timetableLocationOn = locationOn
    this._statusDistKm = distKm

    const filtered = trains.filter(t => t.group === this._trainGroup).slice(0, MAX_TRAINS)

    const exampleTrain = filtered[0]
    const dest = exampleTrain
      ? pxTruncate(exampleTrain.destination.toUpperCase(), DEST_HDR_W - SAFE)
      : 'NO SERVICE'

    const rows =
      filtered.length > 0
        ? filtered.map(fmtTrainRow)
        : ['No trains']

    // Same [current, ...nearby] order as the landing view, with the viewed
    // station marked "> ". The list can't be programmatically scrolled, and a
    // rebuild resets it to the top — so when the viewed station sits past the
    // visible window we slice to a window that keeps it on screen (positioned
    // as if scrolled down to it), instead of snapping back to the top.
    const order = [currentStation, ...nearbyStations.slice(0, MAX_STATIONS - 1)]
    const selIdx = Math.max(0, order.findIndex(s => s.code === station.code))
    const allItems = stationItems(currentStation, nearbyStations, station.code, true)
    let items = allItems
    if (allItems.length > MAX_VISIBLE) {
      const start = Math.max(0, Math.min(selIdx - (MAX_VISIBLE - 1), allItems.length - MAX_VISIBLE))
      items = allItems.slice(start, start + MAX_VISIBLE)
    }
    const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10

    const status = statusStr(distKm)
    const statusW = getTextWidth(status)
    const statusX = W - 4 - statusW

    await withTimeout(
      this._bridge.rebuildPageContainer({
        containerTotalNum: 9,
        imageObject: [img(9, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)],
        textObject: [
          txt(2, 'frame',   PANEL_X,   4, PANEL_W,  252, '', false, PANEL_BW, 4),
          txt(3, 'dir',     PANEL_IX, 12, DEST_HDR_W,  LH, dest, true),
          txt(4, 'switch',  SWITCH_X, 12, SWITCH_BOX_W, LH, SWITCH_LABEL),
          // Full-width rule: spans PANEL_X→PANEL_W so its ends meet the panel's
          // left/right borders (not inset like the text columns).
          txt(5, 'divider', PANEL_X,  46, PANEL_W,      2, '', false, PANEL_BW),
          txt(6, 'hdr',     PANEL_IX, 54, PANEL_IW,    LH, TABLE_HEADER),
          txt(8, 'clock',   statusX, 258, statusW + 4, LH, status),
        ],
        listObject: [
          // Left list: display-only (no selection border), but same padding as
          // the landing view so the station names line up across both screens.
          lst(1, 'stations', LIST_X, 4, LIST_W, listH, items, false, LIST_BW, LIST_RADIUS, false, LIST_PAD),
          // Arrivals: shifted 6px left to offset the SDK's implicit per-item inset.
          // Height sized to the row count so a single train isn't vertically centered.
          lst(7, 'trains', PANEL_IX - 6, 84, PANEL_IW + 6, Math.min(rows.length, MAX_TRAINS) * ROW_PITCH + 6, rows),
        ],
      }),
      'rebuildPageContainer(timetable)',
    )
    // Only claim the timetable view once it is actually on screen — otherwise a
    // failed rebuild would leave taps toggling a direction the user can't see.
    this._view = 'timetable'
    await this._pushLocationIcon(9, locationOn)
    })
  }

  toggleTrainGroup(): void {
    this._trainGroup = this._trainGroup === '1' ? '2' : '1'
  }

  async refreshTimetable(): Promise<void> {
    if (!this._timetableStation) return
    await this.showTimetable(
      this._timetableStation,
      this._timetableTrains,
      this._timetableDistKm,
      this._timetableCurrentStation ?? this._timetableStation,
      this._timetableNearby,
      this._timetableLocationOn,
    )
  }

  // In-place status (distance + clock) update — no rebuild, so the native list
  // selection cursor on the landing view is left untouched. Clock is ID 2 in
  // the stations view, ID 8 in the timetable view.
  async updateStatus(distKm: number = this._statusDistKm): Promise<void> {
    if (this._view === 'splash') return
    // Deliberately outside the render queue: it's the cheap 30s path and must
    // not displace a queued rebuild (latest-wins would drop the rebuild for a
    // mere clock tick). Skipping while a rebuild is in flight is safe — that
    // rebuild draws the current status itself.
    if (this._rendering) return
    this._statusDistKm = distKm
    const id = this._view === 'stations' ? 2 : 8
    try {
      await withTimeout(
        this._bridge.textContainerUpgrade({
          containerID: id,
          containerName: 'clock',
          content: statusStr(distKm),
          contentOffset: 0,
          contentLength: 0,
        }),
        'textContainerUpgrade(clock)',
      )
    } catch { /* non-critical */ }
  }
}
