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
const PANEL_X = 198
const PANEL_W = 374
const PANEL_BW = 2
const PANEL_IX = PANEL_X + PANEL_BW + 6        // inner content x (with 6px interior margin)
const PANEL_IW = PANEL_W - 2 * (PANEL_BW + 6)  // inner content width

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

const ICON_CURRENT = '/icons/Metro Station - Current.png'
const ICON_NEARBY  = '/icons/Metro Station - Standard.png'
const ICON_SIZE    = 24  // icons are 24×24
const ICON_X       = 36
const ICON_Y_OFF   = Math.floor((LH - ICON_SIZE) / 2)  // vertical centering within LH=27
const LIST_X       = ICON_X + ICON_SIZE + 4             // list starts after icon + 4px gap
const CLOCK_X      = 428                                // consistent in both views
const CLOCK_W      = W - CLOCK_X - 4                   // to 4px from right edge

export class GlassesDisplay {
  private _bridge: EvenAppBridge
  private _rendering = false
  private _view: GlassesView = 'splash'
  private _trainGroup: '1' | '2' = '1'
  private _timetableStation: Station | null = null
  private _timetableTrains: Train[] = []
  private _timetableDistKm = 0
  private _imgCache = new Map<string, number[]>()
  private _stationsClockId = 3  // updated in showStations; varies with item count

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
  //   ID 2 — "v0.2.0"          top-left
  //   ID 3 — "METRO TRACKER"   below logo
  //   ID 4 — "Tap to start"    CTA, isEventCapture

  async startup(): Promise<boolean> {
    const logoX = Math.round((W - LOGO_W) / 2)
    const result = await this._bridge.createStartUpPageContainer({
      containerTotalNum: 4,
      imageObject: [img(1, 'logo', logoX, 16, LOGO_W, LOGO_H)],
      textObject: [
        txt(2, 'ver',    10,   6,  160, LH, 'v0.2.0'),
        txt(3, 'title',   0, 172,    W, LH, 'METRO TRACKER'),
        txt(4, 'cta',     0, 218,    W, LH, 'Tap to start', true),
      ],
    })
    this._view = 'splash'
    // Preload images so they're cached before first showStations call
    void this._fetchImg(LOGO_URL)
      .then(bytes =>
        this._bridge.updateImageRawData({ containerID: 1, containerName: 'logo', imageData: bytes }),
      )
      .catch(err => console.warn('Logo load failed:', err))
    void this._fetchImg(ICON_CURRENT).catch(() => {})
    void this._fetchImg(ICON_NEARBY).catch(() => {})
    return result === 0
  }

  // ── Station list ───────────────────────────────────────────────────────
  //
  // Layout: N station icons (24×24) overlaid at each list row y-position.
  // Items never scroll (max 4 = current + 3 nearby), so icons stay aligned.
  //
  //   IDs 1..N — station icons    x=36, y=(4 + i*LH + 1), 24×24
  //   ID N+1   — clock            x=428, y=258  (same position as timetable)
  //   ID N+2   — station list     x=64, y=4     (no text prefix; icon provides distinction)

  async showStations(
    currentStation: Station,
    nearbyStations: Station[],
    distKm: number,
  ): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    const distMi = (distKm * 0.621371).toFixed(1)
    const items = [
      pxTruncate(currentStation.name.toUpperCase(), LIST_X > 60 ? W - LIST_X - 4 : 500),
      ...(nearbyStations.length > 0
        ? nearbyStations.map(s => pxTruncate(s.name.toUpperCase(), W - LIST_X - 4))
        : ['Searching…']),
    ]

    const N = items.length
    const clockId = N + 1
    const listId  = N + 2
    this._stationsClockId = clockId

    const imageObjects = items.map((_, i) =>
      img(i + 1, `icon${i}`, ICON_X, 4 + i * LH + ICON_Y_OFF, ICON_SIZE, ICON_SIZE),
    )

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: N + 2,
        imageObject: imageObjects,
        textObject: [
          txt(clockId, 'clock', CLOCK_X, 258, CLOCK_W, LH, `${clock()}  ${distMi}mi`),
        ],
        listObject: [lst(listId, 'stations', LIST_X, 4, W - LIST_X - 4, 254, items, true)],
      })
    } catch (err) {
      console.error('showStations error:', err)
      return
    } finally {
      this._rendering = false
      this._view = 'stations'
    }

    // Load icon images (cached after first fetch; blank container until loaded)
    items.forEach((item, i) => {
      if (item === 'Searching…') return
      const url = i === 0 ? ICON_CURRENT : ICON_NEARBY
      void this._fetchImg(url)
        .then(bytes =>
          this._bridge.updateImageRawData({ containerID: i + 1, containerName: `icon${i}`, imageData: bytes }),
        )
        .catch(err => console.warn(`Station icon ${i} load failed:`, err))
    })
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
  // Vertical positions inside panel (from top of display):
  //   y=12: station name    (inside frame, y_frame=4 + bw=2 + margin=6)
  //   y=44: direction       (+LH+5)
  //   y=76: table header    (+LH+5)
  //   y=106: list starts    (+LH+3)
  //   y=258: clock

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

    const exampleTrain = filtered[0] ?? trains.find(t => t.group === this._trainGroup)
    const dirLabel = exampleTrain
      ? `${pxTruncate(exampleTrain.destination.toUpperCase(), PANEL_IW - 20)} >`
      : 'Switch Direction >'

    const rows =
      filtered.length > 0
        ? filtered.map(fmtTrainRow)
        : ['No trains — tap to switch']

    const abbrev = pxTruncate(station.name.toUpperCase(), 156)
    const stationFull = pxTruncate(station.name.toUpperCase(), PANEL_IW)

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 8,
        textObject: [
          // Left sidebar
          txt(1, 'line',    18,  34,   4, 224, '', false, 2),
          txt(2, 'abbrev',  36,  34, 156, LH, `° ${abbrev}`),
          // Right panel
          txt(3, 'frame',  PANEL_X, 4, PANEL_W, 280, '', false, PANEL_BW, 4),
          txt(4, 'station', PANEL_IX, 12, PANEL_IW, LH, stationFull),
          txt(5, 'clock',   CLOCK_X, 258, CLOCK_W, LH, clock()),
          txt(6, 'dir',     PANEL_IX, 44, PANEL_IW, LH, dirLabel),
          txt(7, 'hdr',     PANEL_IX, 76, PANEL_IW, LH, TABLE_HEADER),
        ],
        // isEvent on list: scroll=browse trains, tap=toggle direction
        listObject: [lst(8, 'trains', PANEL_IX, 106, PANEL_IW, 148, rows, true)],
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

  // Clock is ID (N+1) in stations view (varies with item count), ID 5 in timetable view.
  async updateClock(): Promise<void> {
    if (this._view === 'splash') return
    const id = this._view === 'stations' ? this._stationsClockId : 5
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
