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
const LIST_NAME_W = LIST_W - LIST_BW * 2 - ITEM_INSET - SAFE   // name truncation budget

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
): ListContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    isEventCapture: isEvent ? 1 : 0,
    borderWidth, borderColor: 15, borderRadius, paddingLength: 0,
    itemContainer: { itemCount: items.length, itemName: items, itemWidth: 0, isItemSelectBorderEn: 0 },
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

// > and - are both 10px wide — names stay left-aligned regardless of prefix
const PREFIX_CURRENT = '>'
const PREFIX_NEARBY  = '-'
const PREFIX_W       = getTextWidth(`${PREFIX_CURRENT} `)

// Direction switcher — its own small container at the panel's right edge, so it
// can never wrap into the destination text. Single press toggles direction.
const SWITCH_LABEL = '< >'
const SWITCH_W     = getTextWidth(SWITCH_LABEL)
const SWITCH_BOX_W = SWITCH_W + 12
const SWITCH_X     = PANEL_IX + PANEL_IW - SWITCH_BOX_W
const DEST_HDR_W   = PANEL_IW - SWITCH_BOX_W - 8   // destination header container width

// Frozen-order list: [current, ...nearby]. The order never changes between the
// list view and the timetable view — only the `>` marker moves to whichever
// station's board is being viewed, so names never jump position.
// Station names keep their natural Title Case (narrower than ALL CAPS).
function stationItems(current: Station, nearby: Station[], markedCode: string): string[] {
  const nameW = LIST_NAME_W - PREFIX_W
  const fmt = (s: Station) => {
    const prefix = s.code === markedCode ? PREFIX_CURRENT : PREFIX_NEARBY
    return `${prefix} ${pxTruncate(s.name, nameW)}`
  }
  const items = [fmt(current)]
  if (nearby.length > 0) {
    for (const s of nearby.slice(0, MAX_STATIONS - 1)) items.push(fmt(s))
  } else {
    items.push(`${PREFIX_NEARBY} Searching...`)
  }
  return items
}

export class GlassesDisplay {
  private _bridge: EvenAppBridge
  private _rendering = false
  private _view: GlassesView = 'splash'
  private _trainGroup: '1' | '2' = '1'
  private _timetableStation: Station | null = null
  private _timetableCurrentStation: Station | null = null
  private _timetableNearby: Station[] = []
  private _timetableTrains: Train[] = []
  private _timetableDistKm = 0
  private _timetableLocationOn = true
  private _imgCache = new Map<string, number[]>()

  constructor(bridge: EvenAppBridge) {
    this._bridge = bridge
  }

  private async _fetchImg(url: string): Promise<number[]> {
    const cached = this._imgCache.get(url)
    if (cached) return cached
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Image fetch ${url}: ${res.status}`)
    const bytes = Array.from(new Uint8Array(await res.arrayBuffer()))
    this._imgCache.set(url, bytes)
    return bytes
  }

  // Push the on/off location icon into a freshly-rebuilt image container.
  // Re-pushed on every rebuild because rebuildPageContainer recreates containers.
  private async _pushLocationIcon(id: number, on: boolean): Promise<void> {
    const url = on ? LOCATION_ON_URL : LOCATION_OFF_URL
    try {
      const bytes = await this._fetchImg(url)
      await this._bridge.updateImageRawData({ containerID: id, containerName: 'loc', imageData: bytes })
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
  //   ID 2 — version (e.g. "v0.5.6") top-left (left-anchored so it never overflows)
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
    const result = await this._bridge.createStartUpPageContainer({
      containerTotalNum: 4,
      imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
      textObject: this._splashText(),
    })
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
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 4,
        imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
        textObject: this._splashText(),
      })
      if (logoBytes) {
        await this._bridge.updateImageRawData({ containerID: 1, containerName: 'logo', imageData: logoBytes })
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
  ): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    const items = stationItems(currentStation, nearbyStations, currentStation.code)
    const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10

    const status = statusStr(distKm)
    const statusW = getTextWidth(status)
    const statusX = W - 4 - statusW

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 3,
        imageObject: [img(3, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)],
        textObject: [
          txt(2, 'clock', statusX, 258, statusW + 4, LH, status),
        ],
        listObject: [lst(1, 'stations', LIST_X, 4, LIST_W, listH, items, true, LIST_BW, LIST_RADIUS)],
      })
      await this._pushLocationIcon(3, locationOn)
    } catch (err) {
      console.error('showStations error:', err)
    } finally {
      this._rendering = false
      this._view = 'stations'
    }
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
  //   y=18:  destination header / switcher
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
    if (this._rendering) return
    this._rendering = true

    this._timetableStation = station
    this._timetableCurrentStation = currentStation
    this._timetableNearby = nearbyStations
    this._timetableTrains = trains
    this._timetableDistKm = distKm
    this._timetableLocationOn = locationOn

    const filtered = trains.filter(t => t.group === this._trainGroup).slice(0, MAX_TRAINS)

    const exampleTrain = filtered[0]
    const dest = exampleTrain
      ? pxTruncate(exampleTrain.destination.toUpperCase(), DEST_HDR_W - SAFE)
      : 'NO SERVICE'

    const rows =
      filtered.length > 0
        ? filtered.map(fmtTrainRow)
        : ['No trains']

    // Frozen list: same [current, ...nearby] order as the landing view;
    // the `>` marker just moves to the station whose board is shown.
    const items = stationItems(currentStation, nearbyStations, station.code)
    const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10

    const status = statusStr(distKm)
    const statusW = getTextWidth(status)
    const statusX = W - 4 - statusW

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 9,
        imageObject: [img(9, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)],
        textObject: [
          txt(2, 'frame',   PANEL_X,   4, PANEL_W,  252, '', false, PANEL_BW, 4),
          txt(3, 'dir',     PANEL_IX, 18, DEST_HDR_W,  LH, dest, true),
          txt(4, 'switch',  SWITCH_X, 18, SWITCH_BOX_W, LH, SWITCH_LABEL),
          txt(5, 'divider', PANEL_IX, 46, PANEL_IW,     2, '', false, PANEL_BW),
          txt(6, 'hdr',     PANEL_IX, 54, PANEL_IW,    LH, TABLE_HEADER),
          txt(8, 'clock',   statusX, 258, statusW + 4, LH, status),
        ],
        listObject: [
          // Left list: own border, same x/width as landing view → no shift.
          lst(1, 'stations', LIST_X, 4, LIST_W, listH, items, false, LIST_BW, LIST_RADIUS),
          // Arrivals: shifted 6px left to offset the SDK's implicit per-item inset.
          // Height sized to the row count so a single train isn't vertically centered.
          lst(7, 'trains', PANEL_IX - 6, 84, PANEL_IW + 6, Math.min(rows.length, MAX_TRAINS) * ROW_PITCH + 6, rows),
        ],
      })
      await this._pushLocationIcon(9, locationOn)
    } catch (err) {
      console.error('showTimetable error:', err)
    } finally {
      this._rendering = false
      this._view = 'timetable'
    }
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

  // Clock is ID 2 in stations view, ID 8 in timetable view.
  async updateClock(): Promise<void> {
    if (this._view === 'splash') return
    const id = this._view === 'stations' ? 2 : 8
    try {
      await this._bridge.textContainerUpgrade({
        containerID: id,
        containerName: 'clock',
        content: statusStr(this._timetableDistKm),
        contentOffset: 0,
        contentLength: 0,
      })
    } catch { /* non-critical */ }
  }
}
