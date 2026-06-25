import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type {
  EvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'
import type { Station, Train } from './wmata'

export type GlassesView = 'splash' | 'stations' | 'timetable'

const W = 576      // display width
const LH = 27      // fixed line height on G2

const LOGO_URL = '/icons/logo_icon_large.png'
const LOGO_W = 144
const LOGO_H = 144

// Timetable right panel
const PANEL_X  = 198
const PANEL_W  = 374
const PANEL_BW = 2
const PANEL_IX = PANEL_X + 20   // 20px horizontal padding from outer border (design guideline)
const PANEL_IW = PANEL_W - 40   // 20px each side → 334px

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
): ListContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    isEventCapture: isEvent ? 1 : 0,
    borderWidth: 0, borderColor: 15, borderRadius: 0, paddingLength: 0,
    itemContainer: { itemCount: items.length, itemName: items, itemWidth: 0, isItemSelectBorderEn: 0 },
  }
}

function clock(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtMin(min: string): string {
  if (min === 'ARR') return 'Arriving'
  if (min === 'BRD') return 'Boarding'
  return `${min}m`
}

// ── Pixel-accurate table columns ───────────────────────────────────────────
//
// Each column target is content + trailing gap, so cells butt together cleanly.
// Computed once at module load — getTextWidth is a pure sync function.

const SPACE_W  = getTextWidth(' ')
const COL_LN   = 32   // "BL"/"YL" + gap
const COL_CAR  = 24   // "6"/"8"   + gap
const COL_MIN  = 84   // "Boarding"=76px, "Arriving"=67px, "20m"=40px + margin
const COL_DEST = PANEL_IW - COL_LN - COL_CAR - COL_MIN  // fills the rest (218px)

const SWITCH_LABEL  = '<>'
const SWITCH_W      = getTextWidth(SWITCH_LABEL)          // 30px
const SWITCH_DEST_W = PANEL_IW - SWITCH_W                 // 304px — budget for destination

function padCol(text: string, targetPx: number): string {
  const w = getTextWidth(text)
  if (w >= targetPx) return pxTruncate(text, targetPx)
  return text + ' '.repeat(Math.max(1, Math.round((targetPx - w) / SPACE_W)))
}

// Header string built once; same column widths as data rows.
const TABLE_HEADER =
  padCol('LN', COL_LN) +
  padCol('C', COL_CAR) +
  padCol('DESTINATION', COL_DEST) +
  'MIN'

function fmtTrainRow(train: Train): string {
  return (
    padCol(train.line, COL_LN) +
    padCol(train.car, COL_CAR) +
    padCol(pxTruncate(train.destination, COL_DEST - 4), COL_DEST) +
    fmtMin(train.min)
  )
}

// ── Main display class ─────────────────────────────────────────────────────

// > and - are both 10px wide — names stay left-aligned regardless of which prefix is used
const PREFIX_CURRENT = '>'
const PREFIX_NEARBY  = '-'
const CLOCK_X = 428   // consistent position in both views
const CLOCK_W = W - CLOCK_X - 4

export class GlassesDisplay {
  private _bridge: EvenAppBridge
  private _rendering = false
  private _view: GlassesView = 'splash'
  private _trainGroup: '1' | '2' = '1'
  private _timetableStation: Station | null = null
  private _timetableTrains: Train[] = []
  private _timetableDistKm = 0
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

  get view(): GlassesView {
    return this._view
  }

  // ── Splash ─────────────────────────────────────────────────────────────
  //
  // Layout:
  //   ID 1 — logo image        centered horizontally
  //   ID 2 — "v0.2.5"          top-left
  //   ID 3 — "METRO TRACKER"   below logo
  //   ID 4 — "Tap to start"    CTA, isEventCapture

  async startup(): Promise<boolean> {
    const logoX = Math.round((W - LOGO_W) / 2)

    // Pre-fetch before creating the container so updateImageRawData can be called
    // immediately after — avoids the async gap where hardware firmware may reject
    // a late image push to a startup container.
    let logoBytes: number[] | null = null
    try {
      logoBytes = await this._fetchImg(LOGO_URL)
    } catch (err) {
      console.warn('Logo prefetch failed:', err)
    }

    const result = await this._bridge.createStartUpPageContainer({
      containerTotalNum: 4,
      imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
      textObject: [
        txt(2, 'ver',   509,   6,   57, LH, 'v0.3.1'),
        txt(3, 'title', 216, 172,  145, LH, 'METRO TRACKER'),
        txt(4, 'cta',   239, 218,   99, LH, 'Tap to start', true),
      ],
    })
    this._view = 'splash'

    if (logoBytes) {
      try {
        await this._bridge.updateImageRawData({ containerID: 1, containerName: 'logo', imageData: logoBytes })
      } catch (err) {
        console.warn('Logo update failed:', err)
      }
    }

    return result === 0
  }

  // ── Station list ───────────────────────────────────────────────────────
  //
  // Layout:
  //   ID 1 — clock    x=428, y=258
  //   ID 2 — list     x=36,  y=4, h=254  (▶ current, ● nearby — both 20px wide)

  async showStations(
    currentStation: Station,
    nearbyStations: Station[],
    distKm: number,
  ): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    const distMi = (distKm * 0.621371).toFixed(1)
    const nameW = W - 36 - 4 - getTextWidth(`${PREFIX_CURRENT} `)
    const items = [
      `${PREFIX_CURRENT} ${pxTruncate(currentStation.name.toUpperCase(), nameW)}`,
      ...(nearbyStations.length > 0
        ? nearbyStations.map(s => `${PREFIX_NEARBY} ${pxTruncate(s.name.toUpperCase(), nameW)}`)
        : [`${PREFIX_NEARBY} Searching…`]),
    ]

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          txt(1, 'clock', CLOCK_X, 258, CLOCK_W, LH, `${clock()}  ${distMi}mi`),
        ],
        listObject: [lst(2, 'stations', 36, 4, W - 36 - 4, 254, items, true)],
      })
    } catch (err) {
      console.error('showStations error:', err)
    } finally {
      this._rendering = false
      this._view = 'stations'
    }
  }

  // ── Timetable ──────────────────────────────────────────────────────────
  //
  // Layout: LEFT sidebar stays visible; RIGHT panel shows arrivals.
  //
  //   Left sidebar (same as station list):
  //     ID 1 — thin vertical line        x=18, w=4, bw=2
  //     ID 2 — abbreviated station name  x=36, w=156
  //
  //   Right panel (bordered, x=198, w=374):
  //     ID 3 — frame border              x=198, y=4, w=374, h=280, bw=2, br=4
  //     ID 4 — station name (full)       inside panel header
  //     ID 5 — clock                     bottom-right inside panel  ← always ID 5
  //     ID 6 — direction label           "LARGO TOWN CTR >" (isEventCapture — tap toggles)
  //     ID 7 — table column header       "LN  C  DEST     MIN"
  //     List  — train rows
  //
  // Vertical positions — 16px top/bottom padding from outer border (design guideline):
  //   content_top    = 4 + 16 = 20
  //   content_bottom = 4 + 252 - 16 = 240
  //   y=20:  station name
  //   y=48:  direction        (+LH+1)
  //   y=76:  table header     (+LH+1)
  //   y=104: list starts      (+LH+1); h=135 (5×LH), ends at y=239 ≤ 240 ✓
  //
  // Panel ends at y=256 (h=252). Clock at y=258 sits 2px below the panel.

  async showTimetable(
    station: Station,
    trains: Train[],
    distKm: number,
  ): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    this._timetableStation = station
    this._timetableTrains = trains
    this._timetableDistKm = distKm

    const filtered = trains.filter(t => t.group === this._trainGroup).slice(0, 5)

    const exampleTrain = filtered[0]
    const dest = exampleTrain
      ? pxTruncate(exampleTrain.destination.toUpperCase(), SWITCH_DEST_W - 4)
      : 'No service'
    const dirLabel = padCol(dest, SWITCH_DEST_W) + SWITCH_LABEL

    const rows =
      filtered.length > 0
        ? filtered.map(fmtTrainRow)
        : ['No trains']

    const abbrev = pxTruncate(station.name.toUpperCase(), 156)
    const stationFull = pxTruncate(station.name.toUpperCase(), PANEL_IW)

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 7,
        textObject: [
          // Left sidebar — no line; ▶ matches the landing page current-station marker
          txt(1, 'abbrev',  36,  34, 156, LH, `${PREFIX_CURRENT} ${abbrev}`),
          // Right panel (h=252 so clock at y=258 sits below the frame)
          txt(2, 'frame',   PANEL_X,   4, PANEL_W,  252, '', false, PANEL_BW, 4),
          txt(3, 'station', PANEL_IX, 20, PANEL_IW, LH,  stationFull),
          txt(4, 'dir',     PANEL_IX, 48, PANEL_IW, LH,  dirLabel, true),
          txt(5, 'hdr',     PANEL_IX, 76, PANEL_IW, LH,  TABLE_HEADER),
          // Clock pinned outside/below the panel, same position as landing page
          txt(6, 'clock',   CLOCK_X, 258, CLOCK_W,  LH,  clock()),
        ],
        // List shifted 6px left to compensate for SDK's implicit per-item left inset,
        // so row text visually aligns with the text containers above.
        listObject: [lst(7, 'trains', PANEL_IX - 6, 104, PANEL_IW + 6, 5 * LH, rows)],
      })
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
    )
  }

  // Clock is ID 1 in stations view, ID 6 in timetable view.
  async updateClock(): Promise<void> {
    if (this._view === 'splash') return
    const id = this._view === 'stations' ? 1 : 6
    try {
      await this._bridge.textContainerUpgrade({
        containerID: id,
        containerName: 'clock',
        content: clock(),
        contentOffset: 0,
        contentLength: 0,
      })
    } catch { /* non-critical */ }
  }
}
