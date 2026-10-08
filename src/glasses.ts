import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type {
  EvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { Station, Train } from './wmata'
import { APP_VERSION } from './version'

export type GlassesView = 'splash' | 'stations' | 'timetable' | 'liveview' | 'calibrate'

// One stop on the live strip. The kind only decides which glyph is drawn; which
// stops are transfers is route topology, so it's decided by the caller.
export type LiveStopKind = 'terminus' | 'transfer' | 'stop'

// A live train on the strip, in the same fractional stop-sequence units as the
// user's own position, so both are placed by identical arithmetic.
export interface LiveTrain {
  line: string        // WMATA line code, e.g. 'YL'
  position: number
  rightward: boolean  // travelling toward destAhead, so drawn above the rail
}

// Everything the live strip draws, already resolved to travel order: `stops` runs
// left to right in the direction the user is moving, and `position` is the user's
// fractional index into it (4.5 = midway between the 5th and 6th stop). Flipping
// for direction happens before this, so the renderer only ever draws rightward.
export interface LiveStripModel {
  line: string
  destAhead: string
  destBehind: string
  stops: LiveStopKind[]
  position: number
  trains: LiveTrain[]
  // Set when there is no strip to draw (route model still loading, or failed).
  // Takes over the top label and blanks the strip.
  note: string | null
}

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

// In-transit badge, immediately right of the location badge. Present only while
// moving — there is a single asset rather than an on/off pair, so "absent" is
// the resting state and the row stays uncluttered when standing still.
const MOTION_URL  = '/icons/Train_is_moving.png'
const MOTION_SIZE = 24
const MOTION_GAP  = 6
const MOTION_X    = LOC_X + LOC_SIZE + MOTION_GAP
const MOTION_Y    = LOC_Y

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

// ── Live view geometry ─────────────────────────────────────────────────────
//
// A horizontal track strip with the user pinned to the centre. Every box here is
// a FIXED size, because this view refreshes by upgrading container contents in
// place rather than rebuilding: textContainerUpgrade carries only a string, so
// there is no opportunity to resize a box to fit new text. Anything that changes
// therefore has to fit the widest string it will ever hold, and is padded rather
// than repositioned.
// The strip occupies the same right-hand panel the timetable's arrivals table
// does, so revealing it swaps one panel for another and leaves the station list
// on the left exactly where it was. Nothing in the left column or the bottom
// status row moves between the two views.
const STRIP_X  = 224                       // left edge of the left gradient cap
const STRIP_W  = 344                       // 224..568
const STRIP_R  = STRIP_X + STRIP_W          // 568
const STRIP_MID = STRIP_X + STRIP_W / 2     // 396 — where the user always sits
const GRAD_W   = 32                        // width of each gradient cap

// Stops are drawn as one text run, spaced by a whole number of space glyphs. That
// only lands on an exact grid because the pitch minus a glyph is divisible by the
// space width, which is what makes 115 the pitch rather than a round 114. At this
// pitch about 3 stops fit the panel, with the middle one being the user's own.
const STOP_PITCH  = 115
const DOT_W       = 20   // every geometric glyph measures exactly 20px
const GAP_SPACES  = (STOP_PITCH - DOT_W) / SPACE_W   // 19
// DOTS_X is load-bearing: centres land at DOTS_X + n*SPACE_W + DOT_W/2, so exact
// centring needs (STRIP_MID - DOTS_X - DOT_W/2) divisible by SPACE_W. 226 gives
// 160 and is exact; 224 gives 162 and is 2px off at every position.
const DOTS_X      = 226
const DOTS_W      = STRIP_R - DOTS_X   // 342
// x of the first drawable glyph's centre. Sub-pitch offset is encoded as leading
// spaces, so a stop whose centre falls left of this simply isn't drawn.
const FIRST_DOT_CENTER = DOTS_X + DOT_W / 2   // 236
const DOTS_BUDGET = DOTS_W - SAFE   // 324

// Stop glyphs. All measure exactly 20px, which is what keeps the row on its grid;
// several plausible alternatives (⬤ ◉ ▬ ▪) measure 4px because the font has no
// glyph for them, so they must not be substituted without re-measuring.
const GLYPH: Record<LiveStopKind, string> = {
  terminus: '◆',
  transfer: '□',
  stop: '○',
}

// The rider's own stop, which is positional rather than topological and so is
// applied at render time rather than baked into the stop list. It overrides the
// glyph the stop would otherwise get: where you are outranks what the stop is.
const CURRENT_GLYPH = '●'

// The rail the stops sit on: a bordered text box with no interior, the same trick
// as the timetable's divider. Everything vertical derives from its centre line.
//
// It is deliberately kept thin. A thicker rail looks better on its own, but it
// swallows the 20px stop glyphs, leaving only a sliver of each circle showing
// above and below. Beads on a wire need a wire.
//
// RAIL_H must equal the height of the drawn bar inside the gradient art, since
// the caps continue this line out to both ends. That bar is 6px.
const RAIL_MID = 105
const RAIL_H   = 6
const RAIL_BW  = RAIL_H / 2   // border with no interior left = a solid bar
// Overlaps each gradient cap by 2px so no seam can show between them.
const RAIL_X   = STRIP_X + GRAD_W - 2
const RAIL_W   = STRIP_W - (GRAD_W - 2) * 2
const RAIL_Y   = RAIL_MID - RAIL_H / 2   // 102

// Gradient caps fading the rail out at both ends.
//
// The art is a 6px bar, but an image container is invalid below 20px tall, so the
// files are padded to a transparent 32x20 with the bar on rows 7-12 — exactly
// where GRAD_Y puts it over the rail. The padding is not cosmetic: the firmware
// scales a source that is smaller than its container, so the unpadded 32x6 files
// rendered roughly 3.3x too tall on real hardware while the emulator drew them at
// native size and hid the problem. Source dimensions must stay equal to
// GRAD_W x GRAD_H, or the caps will not match the rail they continue.
const GRAD_L_URL = '/icons/grad_left.png'
const GRAD_R_URL = '/icons/grad_right.png'
const GRAD_H = 20
const GRAD_Y = RAIL_MID - GRAD_H / 2   // 95, so the bar's rows 7-12 land on 102..107
const GRAD_R_X = STRIP_R - GRAD_W

// pretext measures width only, so where the ink sits inside the 27px line box is
// an estimate until it's screenshotted and measured on a real display.
const GLYPH_INK_MID = 14
const DOTS_Y = RAIL_MID - GLYPH_INK_MID   // 91

// Train rows, one each side of the rail. Which side a train is on says which way
// it is going, matching the destination label on that side.
const TRAINS_ABOVE_Y = 67
const TRAINS_BELOW_Y = 118

// Destination ahead reads top-left, destination behind bottom-right, so each label
// sits on the same side as the trains heading for it.
const LIVE_DESTA_Y = 8
const LIVE_DESTB_Y = 184
const LIVE_DEST_W  = STRIP_W

const AHEAD_ARROW  = '▶'
const BEHIND_ARROW = '◀'

// Status line, sharing the bottom row with the badges exactly as the other views
// do. Unlike them the box is a fixed width sized to the longest string it can
// hold, because an in-place upgrade cannot reposition it to fit the text.
const LIVE_BOT_Y   = 258
const LIVE_CLOCK_W = getTextWidth('12.3mi • 12:00 AM') + SAFE   // 175
const LIVE_CLOCK_X = W - 4 - LIVE_CLOCK_W                       // 397

// Right-align inside a fixed box by padding with space glyphs. The other views
// right-align by positioning the box, which an in-place upgrade can't do, since
// TextContainerUpgrade carries content and never geometry.
function padLeftTo(text: string, boxW: number): string {
  const pad = Math.max(0, Math.round((boxW - SAFE - getTextWidth(text)) / SPACE_W))
  return ' '.repeat(pad) + text
}

// Where stop `i` is drawn, given the user's fractional position. Shared by the
// stop row and the train rows so a train at position 4.5 lands exactly halfway
// between the 5th and 6th dot.
function stripX(i: number, position: number): number {
  return STRIP_MID + (i - position) * STOP_PITCH
}

// Lay tokens along a row at their own x positions, using leading spaces to carry
// the offset. Positions quantise to the 5px space width; a token that would
// collide with its neighbour is dropped rather than allowed to overlap, since two
// overlapping line codes read as a third meaningless one.
function placeTokens(tokens: { x: number; text: string }[], boxX: number, boxW: number): string {
  const limit = boxX + boxW - SAFE
  let out = ''
  let cursor = boxX   // right edge of what's been placed, in px
  let first = true
  for (const token of [...tokens].sort((a, b) => a.x - b.x)) {
    const w = getTextWidth(token.text)
    const gap = Math.round((token.x - w / 2 - cursor) / SPACE_W)
    if (gap < (first ? 0 : 1)) continue        // would touch the previous token
    if (cursor + gap * SPACE_W + w > limit) break
    out += ' '.repeat(gap) + token.text
    cursor += gap * SPACE_W + w
    first = false
  }
  return out
}

// The stop row as one string, centred on the user.
//
// Leading spaces carry the sub-pitch offset, so the row slides smoothly as the
// train moves between stops instead of snapping a whole pitch at a time. Rounding
// that lead to a whole space quantises the row by at most half a space width.
function liveDots(stops: LiveStopKind[], position: number): string {
  if (!stops.length) return ''
  let first = 0
  while (first < stops.length && stripX(first, position) < FIRST_DOT_CENTER) first++
  if (first >= stops.length) return ''

  const lead = Math.max(0, Math.round((stripX(first, position) - FIRST_DOT_CENTER) / SPACE_W))
  // If not even the first stop fits, draw nothing at all. Falling through would
  // emit the lead as a run of trailing spaces with no glyph after it, and that run
  // can be wider than the container, which wraps the row and drops the whole strip
  // a line down the display.
  if (lead * SPACE_W + DOT_W > DOTS_BUDGET) return ''
  // The stop the rider is at, which is simply the nearest one: they sit at the
  // centre of the strip, so the marker hands over to the next stop as they pass the
  // midpoint between the two.
  const current = Math.round(position)
  let out = ' '.repeat(lead)
  let width = lead * SPACE_W
  for (let i = first; i < stops.length; i++) {
    const cost = DOT_W + (i === first ? 0 : GAP_SPACES * SPACE_W)
    // Belt and braces against a wrap: the budget maths says this can't trip, but
    // a wrapped row would push the whole strip a line down.
    if (width + cost > DOTS_BUDGET) break
    if (i !== first) out += ' '.repeat(GAP_SPACES)
    out += i === current ? CURRENT_GLYPH : GLYPH[stops[i]]
    width += cost
  }
  return out
}

// A train's marker: its line code, plus an arrow for the direction it is
// travelling along the line.
//
// The mockup drew this as a stacked pair of images, the train icon nearest the
// rail with a line roundel beyond it. That is not reachable: the SDK allows four
// images per page and the two gradient caps plus the location and in-transit
// badges already claim all four, and the number of trains on screen varies from
// none to several, so a fixed set of image containers could not cover it either.
// The arrow sits on the side the train is heading toward, so it always points away
// from its own label and out of the display: "RD▶" runs right, "◀RD" runs left.
function trainToken(line: string, rightward: boolean): string {
  return rightward ? line + AHEAD_ARROW : BEHIND_ARROW + line
}

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

// The window of station rows to draw, chosen so the marked station is always one
// of them.
//
// The list cannot be scrolled programmatically, and a rebuild resets it to the top,
// so a marked station sitting past the visible window would simply disappear.
// Slicing to a window that contains it renders as though the list had been scrolled
// down to it, which is what keeps the selection visible across a rebuild. The marked
// row lands at the bottom of the window, so the stations above it are the ones you
// have context for.
function stationWindow(current: Station, nearby: Station[], markedCode: string): string[] {
  const all = stationItems(current, nearby, markedCode, true)
  if (all.length <= MAX_VISIBLE) return all
  const order = [current, ...nearby.slice(0, MAX_STATIONS - 1)]
  const marked = Math.max(0, order.findIndex(s => s.code === markedCode))
  const start = Math.max(0, Math.min(marked - (MAX_VISIBLE - 1), all.length - MAX_VISIBLE))
  return all.slice(start, start + MAX_VISIBLE)
}

// Which container holds the distance+clock line in each view. Exhaustive over
// GlassesView on purpose: this was a bare ternary that fell through to the
// timetable's ID for anything that wasn't the station list, so a new view
// silently wrote its clock into whatever container happened to hold that ID —
// here, an image. A missing key is now a compile error instead.
const CLOCK_ID: Record<Exclude<GlassesView, 'splash'>, number> = {
  stations: 2,
  timetable: 8,
  liveview: 8,
  // The calibration page has no clock. updateStatus is never reached while it is
  // up (the refresh timer is stopped for the duration), and 0 is not a valid
  // container ID, so a write that should be impossible fails loudly rather than
  // landing on a real container and corrupting the instructions mid-pose.
  calibrate: 0,
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
  private _inTransit = false
  private _imgCache = new Map<string, number[]>()
  // Live view: the strings currently on screen, so an unchanged poll costs no BLE
  // traffic at all. Cleared whenever the containers themselves are in doubt.
  private _liveDrawn: Record<string, string> = {}
  private _liveListSig = ''
  private _liveDirty = true

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

  // Set from the motion detector. Held as state rather than passed per-render so
  // refreshTimetable() and the periodic refresh pick it up without threading an
  // extra argument through every call site.
  setInTransit(v: boolean): void {
    this._inTransit = v
  }

  get inTransit(): boolean {
    return this._inTransit
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
  //
  // The result is checked, not discarded: the call resolves with a reason string
  // rather than throwing, so an asset the firmware rejects (wrong dimensions, a
  // failed greyscale conversion) used to fail completely silently and leave a
  // blank container with nothing in the log to explain it.
  private async _pushIcon(id: number, name: string, url: string): Promise<void> {
    try {
      const bytes = await this._fetchImg(url)
      const result = await withTimeout(
        this._bridge.updateImageRawData({ containerID: id, containerName: name, imageData: bytes }),
        `updateImageRawData(${name})`,
      )
      if (result !== 'success') {
        console.warn(`Icon rejected (${name}, ${url}): ${result}`)
      }
    } catch (err) {
      console.warn(`Icon load failed (${name}):`, err)
    }
  }

  // In-place content update for one text container. Every non-rebuild write goes
  // through here: it keeps the SDK's object-literal friction to a single site,
  // and gives every caller the same "never throws" contract, since a failed
  // cosmetic update must not abort the render that requested it.
  private async _upgradeText(id: number, name: string, content: string): Promise<boolean> {
    try {
      await withTimeout(
        this._bridge.textContainerUpgrade({
          containerID: id,
          containerName: name,
          content,
          contentOffset: 0,
          contentLength: 0,
        }),
        `textContainerUpgrade(${name})`,
      )
      return true
    } catch {
      return false   // non-critical; the caller retries on its next tick
    }
  }

  // Bottom-left badge row: location state, plus the in-transit badge when
  // moving. Both are re-pushed on every rebuild because rebuildPageContainer
  // recreates the containers.
  private async _pushBadges(locId: number, motionId: number, on: boolean): Promise<void> {
    await this._pushIcon(locId, 'loc', on ? LOCATION_ON_URL : LOCATION_OFF_URL)
    if (this._inTransit) await this._pushIcon(motionId, 'motion', MOTION_URL)
  }

  get view(): GlassesView {
    return this._view
  }

  // ── Splash ─────────────────────────────────────────────────────────────
  //
  //   ID 1 — logo image            centered horizontally
  //   ID 2 — version (e.g. "v0.7.3") top-left (left-anchored so it never overflows)
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

  // ── Tilt calibration (DEV only) ────────────────────────────────────────
  //
  // A self-driving page: it tells the rider which way to look and counts down,
  // so the poses are captured without touching a control. That matters because
  // the G2's controls are behind the ear and on the ring rather than under the
  // instructions, and a long press exits the app, so a press-driven wizard put
  // the exit gesture right next to the capture gesture.
  //
  // Rebuilt on every tick rather than upgraded in place. With no images to
  // re-push a rebuild is a single BLE call, exactly what an upgrade costs, and it
  // buys correct centring: textContainerUpgrade carries content without geometry,
  // so a centred line cannot be re-centred as its width changes.
  //
  // The title carries isEventCapture because a page without one receives no input
  // at all, and cancelling has to stay possible while this is on screen.
  async showCalibration(instruction: string, countdown: string, hint: string): Promise<void> {
    await this._enqueue(async () => {
      const centred = (id: number, name: string, y: number, s: string, isEvent = false) => {
        const w = getTextWidth(s)
        return txt(id, name, Math.round((W - w) / 2), y, w + SAFE, LH, s, isEvent)
      }
      await withTimeout(
        this._bridge.rebuildPageContainer({
          containerTotalNum: 4,
          textObject: [
            centred(1, 'ctitle', 30, 'TILT CALIBRATION', true),
            centred(2, 'cinstr', 110, instruction),
            centred(3, 'ccount', 145, countdown),
            centred(4, 'chint', 240, hint),
          ],
        }),
        'rebuildPageContainer(calibrate)',
      )
      // Claimed only after the rebuild lands, matching every other view: an input
      // arriving mid-render must route against what is actually on screen.
      this._view = 'calibrate'
      // The live view's in-place upgrades assume containers it created. This page
      // replaced them, so the next live render has to rebuild.
      this._liveDirty = true
    })
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

      // IDs 1–3 are always present; the in-transit badge is ID 4 when shown, so
      // the declared count stays 1..N either way.
      const badges = [img(3, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)]
      if (this._inTransit) badges.push(img(4, 'motion', MOTION_X, MOTION_Y, MOTION_SIZE, MOTION_SIZE))

      await withTimeout(
        this._bridge.rebuildPageContainer({
          containerTotalNum: badges.length + 2,
          imageObject: badges,
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
      this._liveDirty = true   // this rebuild replaced the live containers
      await this._pushBadges(3, 4, locationOn)
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

    // Same [current, ...nearby] order as the landing view, with the viewed station
    // marked "> " and the window chosen to keep it on screen.
    const items = stationWindow(currentStation, nearbyStations, station.code)
    const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10

    const status = statusStr(distKm)
    const statusW = getTextWidth(status)
    const statusX = W - 4 - statusW

    // IDs 1–9 are always present; the in-transit badge is ID 10 when shown.
    const badges = [img(9, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE)]
    if (this._inTransit) badges.push(img(10, 'motion', MOTION_X, MOTION_Y, MOTION_SIZE, MOTION_SIZE))

    await withTimeout(
      this._bridge.rebuildPageContainer({
        containerTotalNum: badges.length + 8,
        imageObject: badges,
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
    this._liveDirty = true   // this rebuild replaced the live containers
    await this._pushBadges(9, 10, locationOn)
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

  // ── Live view ──────────────────────────────────────────────────────────
  //
  // The strip replaces only the timetable's arrivals panel. The station list, the
  // location and in-transit badges, and the status line all keep the geometry they
  // have in the timetable, so revealing this swaps one panel and moves nothing.
  //
  //   ID 1  — station list          left, bordered, display-only
  //   ID 2  — destination ahead     top of the panel, left-aligned
  //   ID 3  — rail                  bordered rule the stops sit on
  //   ID 4  — stop row              on the rail, isEventCapture
  //   ID 5  — trains heading ahead  above the rail
  //   ID 6  — trains heading back   below the rail
  //   ID 7  — destination behind    bottom of the panel, right-aligned
  //   ID 8  — status (distance + clock), bottom-right
  //   ID 9  — left gradient cap     image
  //   ID 10 — right gradient cap    image
  //   ID 11 — location badge        image, bottom-left
  //   ID 12 — in-transit badge      image, bottom-left
  //
  // Twelve containers is the protocol maximum, and four images is too, which is
  // what rules out drawing trains as icons.
  //
  // Entering costs one rebuild plus the image pushes. Every poll after that costs
  // at most one text upgrade per row that actually changed, and nothing at all
  // while nothing has moved far enough to change a string. Rebuilding per poll
  // instead would mean five awaited round trips at up to 5s each, inside the
  // render lock, on a 15s timer — both slower than the timer and fresh exposure to
  // the stall that wedged the display before.
  //
  // The in-transit badge is always *declared* even when not shown, so the declared
  // container count never changes: a conditional container would force a full
  // rebuild on every motion flip. Only its image push is conditional.

  private static readonly _LIVE_IDS: Record<string, number> = {
    destA: 2, dots: 4, above: 5, below: 6, destB: 7, clock: 8,
  }

  private _liveStrings(model: LiveStripModel, distKm: number): Record<string, string> {
    const budget = (arrow: string) => LIVE_DEST_W - SAFE - getTextWidth(arrow + ' ')
    // The arrow trails the name on the top row and leads it on the bottom one, so
    // each points outward toward the end of the line it names rather than back at
    // its own text.
    const label = (dest: string, arrow: string, trailing: boolean) =>
      !dest
        ? ''
        : trailing
          ? pxTruncate(dest.toUpperCase(), budget(arrow)) + ' ' + arrow
          : arrow + ' ' + pxTruncate(dest.toUpperCase(), budget(arrow))
    // A note replaces the whole strip rather than sitting alongside it: a rail with
    // no stops on it reads as "no service", which is a different claim.
    const blank = model.note !== null
    const side = (rightward: boolean) =>
      blank
        ? ''
        : placeTokens(
            model.trains
              .filter(t => t.rightward === rightward)
              .map(t => ({ x: stripX(t.position, model.position), text: trainToken(t.line, t.rightward) })),
            STRIP_X,
            STRIP_W,
          )
    return {
      destA: blank ? model.note! : label(model.destAhead, AHEAD_ARROW, true),
      dots: blank ? '' : liveDots(model.stops, model.position),
      above: side(true),
      below: side(false),
      // Right-aligned to the panel's right edge, mirroring the top label.
      destB: blank ? '' : padLeftTo(label(model.destBehind, BEHIND_ARROW, false), LIVE_DEST_W),
      clock: padLeftTo(statusStr(distKm), LIVE_CLOCK_W),
    }
  }

  // Draws the strip, rebuilding only when the containers can't be trusted —
  // arriving from another view, a change to the station list, or after
  // invalidateLive(). Otherwise upgrades in place, writing only what changed.
  async renderLive(
    model: LiveStripModel,
    currentStation: Station,
    nearbyStations: Station[],
    markedCode: string,
    distKm: number,
    locationOn = true,
  ): Promise<void> {
    const next = this._liveStrings(model, distKm)
    // Same window the timetable uses, so the selected station stays put rather than
    // the list snapping back to the top when the strip takes over the panel beside
    // it. List contents can only change by rebuilding, so they are part of what
    // makes the page stale rather than something upgradable alongside the strip.
    const items = stationWindow(currentStation, nearbyStations, markedCode)
    const listSig = items.join('|')

    if (this._view !== 'liveview' || this._liveDirty || listSig !== this._liveListSig) {
      return this._enqueue(async () => {
        this._statusDistKm = distKm
        const listH = Math.min(items.length, MAX_VISIBLE) * ROW_PITCH + 10
        await withTimeout(
          this._bridge.rebuildPageContainer({
            containerTotalNum: 12,
            imageObject: [
              img(9, 'gradL', STRIP_X, GRAD_Y, GRAD_W, GRAD_H),
              img(10, 'gradR', GRAD_R_X, GRAD_Y, GRAD_W, GRAD_H),
              img(11, 'loc', LOC_X, LOC_Y, LOC_SIZE, LOC_SIZE),
              img(12, 'motion', MOTION_X, MOTION_Y, MOTION_SIZE, MOTION_SIZE),
            ],
            textObject: [
              txt(2, 'destA', STRIP_X, LIVE_DESTA_Y, LIVE_DEST_W, LH, next.destA),
              // Border-as-fill: a border half the box height leaves no interior,
              // the same technique the timetable divider uses.
              txt(3, 'rail', RAIL_X, RAIL_Y, RAIL_W, RAIL_H, '', false, RAIL_BW),
              // isEventCapture is not decoration here: a page with no capturing
              // container receives no input at all, so without it this view took
              // neither the press that reverses it nor the double press that
              // leaves it, and became a dead end needing a plugin restart.
              txt(4, 'dots', DOTS_X, DOTS_Y, DOTS_W, LH, next.dots, true),
              txt(5, 'above', STRIP_X, TRAINS_ABOVE_Y, STRIP_W, LH, next.above),
              txt(6, 'below', STRIP_X, TRAINS_BELOW_Y, STRIP_W, LH, next.below),
              txt(7, 'destB', STRIP_X, LIVE_DESTB_Y, LIVE_DEST_W, LH, next.destB),
              txt(8, 'clock', LIVE_CLOCK_X, LIVE_BOT_Y, LIVE_CLOCK_W, LH, next.clock),
            ],
            // Same geometry and padding as the timetable's left list, so station
            // names line up across every view.
            listObject: [
              lst(1, 'stations', LIST_X, 4, LIST_W, listH, items, false, LIST_BW, LIST_RADIUS, false, LIST_PAD),
            ],
          }),
          'rebuildPageContainer(liveview)',
        )
        // Claimed only once the page is actually on screen, so a failed rebuild
        // leaves input routing to whatever the user can still see.
        this._view = 'liveview'
        this._liveDirty = false
        this._liveListSig = listSig
        this._liveDrawn = { ...next }
        await this._pushIcon(11, 'loc', locationOn ? LOCATION_ON_URL : LOCATION_OFF_URL)
        if (this._inTransit) await this._pushIcon(12, 'motion', MOTION_URL)
        await this._pushIcon(9, 'gradL', GRAD_L_URL)
        await this._pushIcon(10, 'gradR', GRAD_R_URL)
      })
    }

    // Outside the render queue for the same reason as updateStatus: latest-wins
    // would drop a queued rebuild in favour of a mere position tick.
    if (this._rendering) return
    this._statusDistKm = distKm
    for (const [name, content] of Object.entries(next)) {
      if (this._liveDrawn[name] === content) continue
      // Re-checked every iteration, because this loop awaits: a rebuild starting
      // between two upgrades would leave the rest of them writing into containers
      // that are no longer the ones on screen. ID 4 is the stop row here and an
      // image container in the station list, so a stray write is not harmless.
      if (this._view !== 'liveview' || this._liveDirty || this._rendering) return
      if (await this._upgradeText(GlassesDisplay._LIVE_IDS[name], name, content)) {
        this._liveDrawn[name] = content
      }
    }
  }

  // Called when the live containers can no longer be trusted — returning from the
  // background, where the OS may have torn the page down. The next render then
  // rebuilds instead of upgrading containers that might not exist.
  invalidateLive(): void {
    this._liveDirty = true
    this._liveDrawn = {}
    this._liveListSig = ''
  }

  // In-place status (distance + clock) update — no rebuild, so the native list
  // selection cursor on the landing view is left untouched.
  async updateStatus(distKm: number = this._statusDistKm): Promise<void> {
    if (this._view === 'splash') return
    // Deliberately outside the render queue: it's the cheap 30s path and must
    // not displace a queued rebuild (latest-wins would drop the rebuild for a
    // mere clock tick). Skipping while a rebuild is in flight is safe — that
    // rebuild draws the current status itself.
    if (this._rendering) return
    this._statusDistKm = distKm
    const status = statusStr(distKm)
    await this._upgradeText(
      CLOCK_ID[this._view],
      'clock',
      // The live view's box is fixed and left-anchored, so its content is padded
      // to sit where the other views position the box itself.
      this._view === 'liveview' ? padLeftTo(status, LIVE_CLOCK_W) : status,
    )
  }
}
