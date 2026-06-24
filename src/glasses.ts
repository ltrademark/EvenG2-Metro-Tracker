import { ImageRawDataUpdate } from '@evenrealities/even_hub_sdk'
import type {
  EvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { Station, Train } from './wmata'

export type GlassesView = 'splash' | 'stations' | 'timetable'

// ── Layout constants ───────────────────────────────────────────────────────
const W = 576

// Sidebar image container IDs (shared across stations + timetable views)
const IMG_TRACK = 1
const IMG_DOT_CUR = 2
const IMG_DOT_1 = 3
const IMG_DOT_2 = 4

// Sidebar Y positions that keep dots roughly aligned with the content rows
const DOT_CUR_Y = 72   // aligns with station name row
const DOT_1_Y = 160    // aligns with first nearby/upcoming item
const DOT_2_Y = 204    // aligns with second nearby/upcoming item

// ── Helpers ────────────────────────────────────────────────────────────────

function txt(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
  content: string,
  isEvent = false,
): TextContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    content,
    borderWidth: 0, borderColor: 15, borderRadius: 0, paddingLength: 0,
    isEventCapture: isEvent ? 1 : 0,
  }
}

function lst(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
  items: string[],
): ListContainerProperty {
  return {
    containerID: id, containerName: name,
    xPosition: x, yPosition: y, width: w, height: h,
    isEventCapture: 0,
    borderWidth: 0, borderColor: 15, borderRadius: 0, paddingLength: 0,
    itemContainer: { itemCount: items.length, itemName: items, itemWidth: 0, isItemSelectBorderEn: 0 },
  }
}

function img(
  id: number, name: string,
  x: number, y: number, w: number, h: number,
): ImageContainerProperty {
  return { containerID: id, containerName: name, xPosition: x, yPosition: y, width: w, height: h }
}

function clock(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtMin(min: string): string {
  if (min === 'ARR' || min === 'BRD') return min
  return `${min}m`
}

function fmtTrainRow(train: Train): string {
  const line = train.line.padEnd(2)
  const car = train.car.padStart(1)
  const min = fmtMin(train.min).padStart(4)
  const dest =
    train.destination.length > 20
      ? train.destination.slice(0, 19) + '…'
      : train.destination.padEnd(20)
  return `${line}  ${car}  ${dest}  ${min}`
}

// Sidebar images shared by stations + timetable
function sidebarImages(): ImageContainerProperty[] {
  return [
    img(IMG_TRACK,   'track',   12, 30, 12, 144),
    img(IMG_DOT_CUR, 'dot_cur',  0, DOT_CUR_Y, 24, 24),
    img(IMG_DOT_1,   'dot_1',    0, DOT_1_Y,   24, 24),
    img(IMG_DOT_2,   'dot_2',    0, DOT_2_Y,   24, 24),
  ]
}

// ── Display class ──────────────────────────────────────────────────────────

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

  get view(): GlassesView {
    return this._view
  }

  // ── Image loading ──────────────────────────────────────────────────────

  private async _fetchImg(url: string): Promise<number[] | null> {
    if (this._imgCache.has(url)) return this._imgCache.get(url)!
    try {
      const resp = await fetch(url)
      const buf = await resp.arrayBuffer()
      const bytes = Array.from(new Uint8Array(buf))
      this._imgCache.set(url, bytes)
      return bytes
    } catch {
      return null
    }
  }

  private async _pushImg(containerID: number, url: string): Promise<void> {
    const bytes = await this._fetchImg(url)
    if (!bytes) return
    await this._bridge.updateImageRawData(
      new ImageRawDataUpdate({ containerID, imageData: bytes }),
    )
  }

  private async _pushSidebar(): Promise<void> {
    await Promise.all([
      this._pushImg(IMG_TRACK,   '/icons/Metro Track.png'),
      this._pushImg(IMG_DOT_CUR, '/icons/Metro Station - Current.png'),
      this._pushImg(IMG_DOT_1,   '/icons/Metro Station - Standard.png'),
      this._pushImg(IMG_DOT_2,   '/icons/Metro Station - Standard.png'),
    ])
  }

  // ── Splash ─────────────────────────────────────────────────────────────

  async startup(): Promise<boolean> {
    const result = await this._bridge.createStartUpPageContainer({
      containerTotalNum: 4,
      imageObject: [img(1, 'logo', 218, 24, 140, 140)],
      textObject: [
        txt(2, 'ver',   494, 8,   82, 20, 'v0.1.0'),
        txt(3, 'title',   0, 174, W,  32, 'METRO TRACKER'),
        txt(4, 'cta',     0, 218, W,  36, '► Tap to Start ◄', true),
      ],
    })
    void this._pushImg(1, '/icons/logo_icon_large.png')
    this._view = 'splash'
    return result === 0
  }

  // ── Station list ───────────────────────────────────────────────────────

  async showStations(
    currentStation: Station,
    nearbyStations: Station[],
    distKm: number,
  ): Promise<void> {
    if (this._rendering) return
    this._rendering = true

    const distMi = (distKm * 0.621371).toFixed(1)
    const items =
      nearbyStations.length > 0
        ? nearbyStations.map(s =>
            s.name.length > 34 ? s.name.slice(0, 33) + '…' : s.name,
          )
        : ['Searching…']

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 10,
        imageObject: sidebarImages(),
        textObject: [
          txt(5, 'lbl_cur',  42, 58,  120, 18, 'Current'),
          txt(6, 'station',  42, 76,  360, 36, currentStation.name.toUpperCase(), true),
          txt(7, 'hint',     42, 114, 220, 18, '▼ View Arrivals'),
          txt(8, 'lbl_near', 42, 138, 120, 18, 'Nearby'),
          txt(9, 'clock',   430, 262, 146, 22, `${clock()}  ${distMi}mi`),
        ],
        listObject: [lst(10, 'nearby', 42, 156, 420, 100, items)],
      })
      await this._pushSidebar()
    } catch (err) {
      console.error('showStations error:', err)
    } finally {
      this._rendering = false
      this._view = 'stations'
    }
  }

  // ── Timetable ──────────────────────────────────────────────────────────

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

    const filtered = trains.filter(t => t.group === this._trainGroup).slice(0, 6)

    // Label shows the terminal of the trains currently on screen (tap to switch)
    const exampleTrain = filtered[0] ?? trains.find(t => t.group === this._trainGroup)
    const dirLabel = exampleTrain
      ? `► ${exampleTrain.destination.slice(0, 18).toUpperCase()}`
      : '► Switch Dir'

    const rows =
      filtered.length > 0 ? filtered.map(fmtTrainRow) : ['No trains — tap to switch dir']

    try {
      await this._bridge.rebuildPageContainer({
        containerTotalNum: 9,
        imageObject: sidebarImages(),
        textObject: [
          txt(5, 'station', 42,  8,  230, 28, station.name.toUpperCase()),
          txt(6, 'dir',    290,  8,  286, 28, dirLabel, true),
          txt(7, 'hdr',    290, 40,  286, 20, 'LN  CAR  DESTINATION         MIN'),
          txt(8, 'clock',  430, 260, 146, 22, clock()),
        ],
        listObject: [lst(9, 'trains', 290, 62, 286, 186, rows)],
      })
      await this._pushSidebar()
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

  // Update only the clock container without rebuilding the whole page.
  async updateClock(): Promise<void> {
    if (this._view === 'splash') return
    const containerID = this._view === 'timetable' ? 8 : 9
    const containerName = 'clock'
    try {
      await this._bridge.textContainerUpgrade({
        containerID,
        containerName,
        content: clock(),
        contentOffset: 0,
        contentLength: 0,
      })
    } catch { /* non-critical */ }
  }
}
