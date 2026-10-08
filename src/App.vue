<template>
  <div class="app" :class="{ live: liveView, searching: searchOpen }">
    <SearchBar
      v-if="!liveView"
      :stations="stations"
      @select="onSelectStation"
      @open-change="searchOpen = $event"
    />

    <div class="map-wrap">
      <div ref="mapEl" class="map"></div>

      <div v-if="liveView" class="update-counter">Updating in {{ countdown }}s</div>

      <button class="info-btn" @click="showInfo = true">
        <span class="info-ic" v-html="icQueryRaw"></span>
        <span class="info-ver">v{{ version }}</span>
      </button>

      <!-- Live View toggle (also the way back to the normal view) -->
      <button class="live-btn" :class="{ active: liveView }" @click="toggleLive">
        <span class="live-dot" v-html="liveIconRaw"></span>
        <span>{{ liveView ? 'Exit Live View' : 'Live View' }}</span>
      </button>

      <button class="loc-btn" @click="recenter" aria-label="My location">
        <span class="loc-ic" :style="{ color: locIconColor }" v-html="locIconSvg"></span>
      </button>
    </div>

    <StationPanel
      :station="currentStation"
      :is-pinned="isPinned"
      :dist-km="currentDistKm"
      :has-gps="userLat !== null"
      :trains="trains"
    />

    <InfoModal v-if="showInfo" @close="showInfo = false" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import * as L from 'leaflet'
import { initBridge } from './bridge'
import type { BridgeControls } from './bridge'
import { wmataClient, bearingDeg } from './wmata'
import type { Station, Train, PlacedTrain } from './wmata'
import { lineIconUrl, lineColor } from './lineIcons'
import { APP_VERSION } from './version'
import StationPanel from './components/StationPanel.vue'
import SearchBar from './components/SearchBar.vue'
import InfoModal from './components/InfoModal.vue'
import icQueryRaw from './assets/query icon.svg?raw'
import liveIconRaw from './assets/LiveIcon.svg?raw'
import locOffRaw from './assets/location-state_off.svg?raw'
import locOnRaw from './assets/location-state_on.svg?raw'
import dir1Raw from './assets/Train_dir_1.svg?raw'
import dir2Raw from './assets/Train_dir_2.svg?raw'
import stationDotRaw from './assets/Station_dot.svg?raw'
import stationConnRaw from './assets/Station_dot--connection.svg?raw'
import pinUser from './assets/Pindrop.svg'

// WMATA refreshes train positions every ~7–10s, so 10s polling stays fresh
// without redundant calls (well within the 50k/day, 10/s rate limits).
const POLL_SECS = 10
const POLL_MS = POLL_SECS * 1000

// The map used to extend behind the panel's rounded top, and centring offset by
// half of that so the framing looked right. In the light design the panel is flush,
// so there is nothing to compensate for.
const MAP_UNDERLAP = 0

// Blue teardrop marking the user's GPS position (tip at the coordinate).
const USER_PIN = L.icon({ iconUrl: pinUser, iconSize: [40, 40], iconAnchor: [20, 38] })

// Fixed draw order for the parallel-ribbon offset — a line always sits on the
// same side relative to its neighbours. Offsets are in pixels (constant across
// zoom), so shared trunks render as evenly-spaced colored ribbons.
const LINE_ORDER = ['RD', 'OR', 'SV', 'BL', 'YL', 'GR']
const LINE_W = 3
const LINE_GAP = 1
// Max px a connection hub may be nudged from the station centre (offsets span
// ±10px; a clean diagonal crossing reaches ~14px). Beyond this we treat the
// least-squares crossing as unstable and fall back to the centroid.
const MAX_HUB_SHIFT = 16

function offsetPx(line: string): number {
  const i = LINE_ORDER.indexOf(line)
  const idx = i < 0 ? (LINE_ORDER.length - 1) / 2 : i
  return (idx - (LINE_ORDER.length - 1) / 2) * (LINE_W + LINE_GAP)
}

// Shift a polyline perpendicular by a constant pixel amount in the current
// projection (recomputed on zoom). Per-vertex normal = mean of adjacent
// segment normals, so corners miter reasonably.
function offsetLatLngs(map: L.Map, latlngs: L.LatLng[], px: number): L.LatLng[] {
  if (!px) return latlngs
  const pts = latlngs.map(ll => map.latLngToLayerPoint(ll))
  const out: L.LatLng[] = []
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]
    let nx = 0, ny = 0, n = 0
    const add = (a: L.Point, b: L.Point) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      nx += -dy / len; ny += dx / len; n++
    }
    if (i > 0) add(pts[i - 1], cur)
    if (i < pts.length - 1) add(cur, pts[i + 1])
    if (n) { nx /= n; ny /= n; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l }
    out.push(map.layerPointToLatLng(L.point(cur.x + nx * px, cur.y + ny * px)))
  }
  return out
}

// Unit normal of a polyline at vertex `idx` in layer-pixel space (same basis as
// offsetLatLngs), plus that vertex's layer point. Used to place a connection
// hub at the least-squares intersection of its lines' offset ribbons.
function segNormalPx(map: L.Map, latlngs: L.LatLng[], idx: number): { c: L.Point; nx: number; ny: number } {
  const pts = latlngs.map(ll => map.latLngToLayerPoint(ll))
  const cur = pts[idx]
  let nx = 0, ny = 0, n = 0
  const add = (a: L.Point, b: L.Point) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    nx += -dy / len; ny += dx / len; n++
  }
  if (idx > 0) add(pts[idx - 1], cur)
  if (idx < pts.length - 1) add(cur, pts[idx + 1])
  if (n) { nx /= n; ny /= n; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l }
  return { c: cur, nx, ny }
}

// Live-train marker: train SVG recolored to its line, rotated so its arrow
// leads along travel, and shifted onto its line's ribbon.
//   bearing      = travel direction (drives the arrow rotation)
//   geomBearing  = line geometry direction (drives the ribbon-side offset)
const TRAIN_SIZE = 26
function trainIcon(line: string, bearing: number, geomBearing: number): L.DivIcon {
  const color = lineColor(line)
  // Pick the mirror whose arrow side matches travel (E-pointing dir 1 for
  // eastward travel, W-pointing dir 2 for westward) so same-direction trains
  // look identical, then rotate so the arrow points exactly along travel.
  const westward = Math.sin((bearing * Math.PI) / 180) < 0
  const svg = (westward ? dir2Raw : dir1Raw)
    .replace('fill="white"', `fill="${color}"`)
    .replace('width="50" height="50"', `width="${TRAIN_SIZE}" height="${TRAIN_SIZE}"`)
  const rot = bearing - (westward ? 270 : 90)
  // Offset onto the ribbon follows the line's geometry direction, not travel.
  const off = offsetPx(line)
  const rad = (geomBearing * Math.PI) / 180
  const ox = Math.cos(rad) * off
  const oy = Math.sin(rad) * off
  const c = TRAIN_SIZE / 2
  const html = `<div class="train-arrow" style="transform:rotate(${rot}deg)">${svg}</div>`
  return L.divIcon({ html, className: 'train-marker', iconSize: [TRAIN_SIZE, TRAIN_SIZE], iconAnchor: [c - ox, c - oy] })
}

// Station markers: a small white dot for normal stops, a larger ringed dot for
// transfer (dual-code) stations. A custom className drops Leaflet's default box.
const STATION_SIZE = 14
const STATION_CONN_SIZE = 22
function stationDotIcon(isConnection: boolean): L.DivIcon {
  const size = isConnection ? STATION_CONN_SIZE : STATION_SIZE
  const raw = isConnection ? stationConnRaw : stationDotRaw
  const svg = raw.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
  return L.divIcon({ html: svg, className: 'station-dot', iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

// Tap-a-train popup: line icon → destination, car count, train number.
function trainPopupHtml(t: PlacedTrain): string {
  const dest = t.destination
    ? wmataClient.getStationByCode(t.destination)?.name ?? t.destination
    : 'No Passenger'
  const meta = [t.carCount ? `${t.carCount}-car` : '', t.trainNumber ? `Train ${t.trainNumber}` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    `<div class="train-popup">` +
    `<div class="tp-head"><img class="tp-icon" src="${lineIconUrl(t.line)}" alt="${t.line}" />` +
    `<span class="tp-dest">${dest}</span></div>` +
    (meta ? `<div class="tp-meta">${meta}</div>` : '') +
    `</div>`
  )
}

// Non-reactive Leaflet/bridge state keyed by component instance
type Private = {
  map: L.Map | null
  userPin: L.Marker | null
  stationMarkers: { station: Station; marker: L.Marker; isConnection: boolean }[]
  stationDots: { marker: L.Marker; pts: L.LatLng[]; idx: number; offset: number }[]
  connectionDots: { marker: L.Marker; segs: { pts: L.LatLng[]; idx: number; offset: number }[] }[]
  bridgeControls: BridgeControls | null
  hasZoomed: boolean
  programmatic: boolean
  trainLayer: L.LayerGroup | null
  trainTimer: ReturnType<typeof setInterval> | null
  countdownTimer: ReturnType<typeof setInterval> | null
  trainState: Map<string, { lat: number; lon: number; bearing: number }>
  trainMarkers: Map<string, L.Marker>
  lineLayer: L.LayerGroup | null
  linePolys: { poly: L.Polyline; center: L.LatLng[]; offset: number }[]
}
const _p = new WeakMap<object, Private>()

export default defineComponent({
  name: 'App',
  components: { StationPanel, SearchBar, InfoModal },

  data() {
    return {
      version: APP_VERSION,
      icQueryRaw,
      liveIconRaw,
      stations: [] as Station[],
      trains: [] as Train[],
      currentStation: null as Station | null,
      currentDistKm: 0,
      userLat: null as number | null,
      userLon: null as number | null,
      isPinned: false,
      centeredOnUser: false,
      showInfo: false,
      liveView: false,
      // Search takes over the whole area below the field, so the map and the
      // boarding panel step aside rather than being overlaid.
      searchOpen: false,
      countdown: POLL_SECS,
    }
  },

  computed: {
    // Location button: off/on icon × white(no GPS)/blue(GPS) tint.
    //   no GPS        → off + white
    //   GPS, panned   → off + blue
    //   GPS, centered → on  + blue
    locIconSvg(): string {
      return this.userLat !== null && this.centeredOnUser ? locOnRaw : locOffRaw
    },
    // Coloured through CSS rather than by rewriting the markup. The icons declare
    // fill="currentColor", so inheriting a colour from the wrapper cannot silently
    // stop working: string surgery against a literal fill broke the moment the
    // assets were re-exported without that exact attribute, and did so invisibly.
    locIconColor(): string {
      return this.userLat !== null ? 'var(--c-text)' : 'var(--c-text-faint)'
    },
  },

  watch: {
    stations(newStations: Station[]) {
      if (newStations.length > 0) this._placeStationMarkers()
    },
    // The map is display:none while search results are up, so it has no size to
    // measure and comes back blank. Remeasuring on the way back is the documented
    // remedy, and it has to wait for the DOM to actually be laid out again.
    searchOpen(open: boolean) {
      if (open) return
      const p = _p.get(this)
      this.$nextTick(() => p?.map?.invalidateSize())
    },
    currentStation() {
      const p = _p.get(this)
      // Pan to a manually selected station; before the first GPS fix, also
      // center on the known/persisted station so the user sees their area.
      if (this.currentStation && p?.map && (this.isPinned || !p.hasZoomed)) {
        this._setView(this.currentStation.lat, this.currentStation.lon, 15)
      }
    },
    userLat() {
      if (this.userLat !== null && this.userLon !== null) this._renderUserPin(this.userLat, this.userLon)
    },
    userLon() {
      if (this.userLat !== null && this.userLon !== null) this._renderUserPin(this.userLat, this.userLon)
    },
  },

  methods: {
    onSelectStation(station: Station) {
      this.pinStation(station.code)
    },

    async toggleLive() {
      this.liveView = !this.liveView
      if (this.liveView) await this._startLive()
      else this._stopLive()
      // Map container resized (panel hidden/shown) — let Leaflet recalc.
      this.$nextTick(() => _p.get(this)?.map?.invalidateSize())
    },

    async _startLive() {
      const p = _p.get(this)
      if (!p?.map) return
      if (!p.trainLayer) p.trainLayer = L.layerGroup().addTo(p.map)
      try {
        await wmataClient.loadStandardRoutes()
      } catch (err) {
        console.warn('StandardRoutes load failed:', err)
      }
      await this._pollTrains()
      p.trainTimer = setInterval(() => void this._pollTrains(), POLL_MS)
      this.countdown = POLL_SECS
      p.countdownTimer = setInterval(() => {
        this.countdown = Math.max(0, this.countdown - 1)
      }, 1000)
    },

    _stopLive() {
      const p = _p.get(this)
      if (!p) return
      if (p.trainTimer) { clearInterval(p.trainTimer); p.trainTimer = null }
      if (p.countdownTimer) { clearInterval(p.countdownTimer); p.countdownTimer = null }
      p.trainLayer?.clearLayers()
      p.trainMarkers.clear()
      p.trainState.clear()
    },

    async _pollTrains() {
      const p = _p.get(this)
      if (!p?.map || !p.trainLayer) return
      try {
        const trains = await wmataClient.fetchTrainPositions()
        const placed = wmataClient.placeTrains(trains)
        const state = p.trainState
        const markers = p.trainMarkers
        const seen = new Set<string>()
        for (const t of placed) {
          seen.add(t.trainId)
          // Travel direction comes from how the train actually moved since the
          // last poll (reliable); fall back to geometry on first sight, and
          // keep the last heading while dwelling at a station.
          const prev = state.get(t.trainId)
          let bearing = t.geomBearing
          if (prev) {
            const moved = Math.hypot(t.lat - prev.lat, t.lon - prev.lon)
            bearing = moved > 1e-4 ? bearingDeg(prev.lat, prev.lon, t.lat, t.lon) : prev.bearing
          }
          state.set(t.trainId, { lat: t.lat, lon: t.lon, bearing })
          const icon = trainIcon(t.line, bearing, t.geomBearing)
          // Reuse the marker by id so an open popup survives the refresh.
          const m = markers.get(t.trainId)
          if (m) {
            m.setLatLng([t.lat, t.lon])
            m.setIcon(icon)
            m.setPopupContent(trainPopupHtml(t))
          } else {
            const nm = L.marker([t.lat, t.lon], { icon, interactive: true })
            nm.bindPopup(trainPopupHtml(t), { closeButton: true, className: 'train-popup-wrap' })
            nm.addTo(p.trainLayer)
            markers.set(t.trainId, nm)
          }
        }
        for (const [id, m] of markers) {
          if (!seen.has(id)) { m.remove(); markers.delete(id); state.delete(id) }
        }
        this.countdown = POLL_SECS
      } catch (err) {
        console.warn('TrainPositions fetch failed:', err)
      }
    },

    recenter() {
      const p = _p.get(this)
      if (!p?.map || this.userLat === null || this.userLon === null) return
      // Returning to "my location" also drops any manual station selection.
      if (this.isPinned) {
        this.isPinned = false
        p.bridgeControls?.unpin()
      }
      this._setView(this.userLat, this.userLon, 15)
      this.centeredOnUser = true
    },

    pinStation(code: string) {
      this.isPinned = true
      this.centeredOnUser = false
      _p.get(this)?.bridgeControls?.pinStation(code)
    },

    _setView(lat: number, lon: number, zoom: number) {
      const p = _p.get(this)
      if (!p?.map) return
      p.programmatic = true
      // The map extends MAP_UNDERLAP px below the visible area (behind the
      // panel), so its center is low — nudge the target up by half that to keep
      // the same framing as a non-underlapped map.
      const pt = p.map.project([lat, lon], zoom).add([0, MAP_UNDERLAP / 2])
      p.map.setView(p.map.unproject(pt, zoom), zoom)
    },

    _initMap() {
      const el = this.$refs.mapEl as HTMLElement
      const map = L.map(el, { zoomControl: false, maxZoom: 19 }).setView([38.9072, -77.0369], 11)
      // Carto's tiles started demanding an API key in August 2026. OpenFreeMap
      // needs none and its Positron style is the same light basemap. It is vector,
      // so MapLibre draws it inside a Leaflet layer and every overlay stays Leaflet.
      // Style, tiles, fonts and sprites all come from this one whitelisted origin.
      // MapLibre is most of the bundle, so it loads on its own after the overlays
      // and the glasses are already up; nothing else waits on the basemap.
      // MapLibre 6 finds its worker beside its own module file, which bundling
      // breaks; Vite builds the worker as its own asset and we point MapLibre at it.
      Promise.all([
        import('@maplibre/maplibre-gl-leaflet'),
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]).then(([{ maplibreGL }, { setWorkerUrl }, { default: workerUrl }]) => {
        setWorkerUrl(workerUrl)
        maplibreGL({
          style: 'https://tiles.openfreemap.org/styles/positron',
          // The data licence requires the credit. Plain text replaces the style's
          // own, whose links would navigate the host WebView away from the app.
          attributionControl: { customAttribution: '© OpenMapTiles © OpenStreetMap' },
        }).addTo(map)
      }).catch(err => console.warn('basemap failed to load:', err))
      map.attributionControl.setPrefix(false).setPosition('bottomleft')
      // Route lines sit below the station dots (default overlay pane).
      map.createPane('lines')
      map.getPane('lines')!.style.zIndex = '350'
      const p = _p.get(this)!
      p.map = map
      // Any user-driven move clears the "centered on me" state.
      map.on('movestart', () => {
        if (!p.programmatic) this.centeredOnUser = false
      })
      map.on('moveend', () => {
        p.programmatic = false
      })
      // Pixel offsets are zoom-dependent — recompute ribbons + dots after a zoom.
      map.on('zoomend', () => { this._renderLineOffsets(); this._renderStationDots() })
    },

    _placeStationMarkers() {
      const p = _p.get(this)!
      if (!p.map) return
      // Dual-code transfer stations (Metro Center, Gallery Pl, L'Enfant, Fort
      // Totten) appear as two rows sharing a name/platform. Merge each pair into
      // one dot — combining its lines — and mark it as a connection so it gets
      // the larger ringed icon. All other stations get the plain dot.
      const seen = new Set<string>()
      for (const station of this.stations) {
        if (seen.has(station.code)) continue
        seen.add(station.code)
        let lines = station.lines
        const isConnection = !!station.secondaryCode
        if (station.secondaryCode) {
          seen.add(station.secondaryCode)
          const pair = this.stations.find(o => o.code === station.secondaryCode)
          if (pair) lines = [...new Set([...lines, ...pair.lines])]
        }
        const marker = L.marker([station.lat, station.lon], {
          icon: stationDotIcon(isConnection),
          interactive: true,
        })
          // Classed so it can be themed. Unclassed, Leaflet's own stylesheet wins
          // and the tooltip renders as light-on-white inside an all-dark UI.
          .bindTooltip(station.name, { className: 'station-tip' })
          .addTo(p.map)
        marker.on('click', () => this.pinStation(station.code))
        p.stationMarkers.push({ station: { ...station, lines }, marker, isConnection })
      }
    },

    // Once route geometry is loaded, promote single-platform junction stations
    // (Rosslyn, Pentagon, …) to the connection icon. Runs after _drawLines so
    // getConnectionCodes() has topology to work with.
    _applyConnectionStyle() {
      const p = _p.get(this)
      if (!p?.map) return
      const junctions = wmataClient.getConnectionCodes()
      for (const e of p.stationMarkers) {
        if (e.isConnection) continue
        const sec = e.station.secondaryCode
        if (junctions.has(e.station.code) || (sec != null && junctions.has(sec))) {
          e.isConnection = true
          e.marker.setIcon(stationDotIcon(true))
        }
      }
    },

    // Shift each dot onto its line's ribbon (to the centre of its bundle for
    // transfer stations) so dots sit on the lines, not the un-offset centreline.
    _buildStationDots() {
      const p = _p.get(this)
      if (!p?.map) return
      p.stationDots = []
      p.connectionDots = []
      for (const { station, marker, isConnection } of p.stationMarkers) {
        const lines = station.lines.filter(l => wmataClient.getLinePath(l).length >= 2)
        if (lines.length === 0) continue
        // Local 3-point segment of a line at this station (for the perpendicular).
        const seg3 = (line: string) => {
          const path = wmataClient.getLinePath(line)
          const i = path.findIndex(pt => pt.lat === station.lat && pt.lon === station.lon)
          if (i < 0) return null
          const pts: L.LatLng[] = []
          let idx = 0
          if (i > 0) { pts.push(L.latLng(path[i - 1].lat, path[i - 1].lon)); idx = 1 }
          pts.push(L.latLng(station.lat, station.lon))
          if (i < path.length - 1) pts.push(L.latLng(path[i + 1].lat, path[i + 1].lon))
          return { pts, idx }
        }
        if (isConnection) {
          // Hub dot: keep one segment per line so it can be placed at the
          // intersection of all its (offset) ribbons, not a single one.
          const segs = []
          for (const l of lines) {
            const s = seg3(l)
            if (s) segs.push({ pts: s.pts, idx: s.idx, offset: offsetPx(l) })
          }
          if (segs.length) p.connectionDots.push({ marker, segs })
          continue
        }
        const offset = lines.reduce((a, l) => a + offsetPx(l), 0) / lines.length
        if (offset === 0) continue // already centred
        const s = seg3(lines[0])
        if (s) p.stationDots.push({ marker, pts: s.pts, idx: s.idx, offset })
      }
      this._renderStationDots()
    },

    _renderStationDots() {
      const p = _p.get(this)
      if (!p?.map) return
      for (const d of p.stationDots) {
        d.marker.setLatLng(offsetLatLngs(p.map, d.pts, d.offset)[d.idx])
      }
      // Connection hub: solve for the point closest to every line's offset
      // ribbon centre-line (least squares). Δ = A⁻¹·v where A = Σ nᵢnᵢᵀ and
      // v = Σ offsetᵢ·nᵢ. Lands the dot on the actual ribbon crossing.
      for (const d of p.connectionDots) {
        let Axx = 0, Axy = 0, Ayy = 0, vx = 0, vy = 0
        let c: L.Point | null = null
        for (const s of d.segs) {
          const nrm = segNormalPx(p.map, s.pts, s.idx)
          c = nrm.c
          Axx += nrm.nx * nrm.nx; Axy += nrm.nx * nrm.ny; Ayy += nrm.ny * nrm.ny
          vx += s.offset * nrm.nx; vy += s.offset * nrm.ny
        }
        if (!c) continue
        // Default to the bounded centroid of the offset ribbons. Use the exact
        // least-squares crossing only when the ribbons cross cleanly (matrix
        // well-conditioned) AND the result stays near the bundle — a shallow
        // branch (e.g. East Falls Church, where Orange/Silver barely diverge)
        // is near-singular and would otherwise fling the dot far off.
        const k = d.segs.length || 1
        let dx = vx / k, dy = vy / k
        const det = Axx * Ayy - Axy * Axy
        if (Math.abs(det) > 1e-3) {
          const lx = (Ayy * vx - Axy * vy) / det
          const ly = (Axx * vy - Axy * vx) / det
          if (Math.hypot(lx, ly) <= MAX_HUB_SHIFT) { dx = lx; dy = ly }
        }
        d.marker.setLatLng(p.map.layerPointToLatLng(L.point(c.x + dx, c.y + dy)))
      }
    },

    // Draw each line's centerline as a colored ribbon, offset so shared trunks
    // fan out instead of overlapping. Requires loadStandardRoutes() first.
    _drawLines() {
      const p = _p.get(this)
      if (!p?.map) return
      if (!p.lineLayer) p.lineLayer = L.layerGroup().addTo(p.map)
      p.lineLayer.clearLayers()
      p.linePolys = []
      for (const line of wmataClient.getLineCodes()) {
        const path = wmataClient.getLinePath(line)
        if (path.length < 2) continue
        const center = path.map(pt => L.latLng(pt.lat, pt.lon))
        const poly = L.polyline(center, {
          color: lineColor(line),
          weight: LINE_W,
          opacity: 0.95,
          pane: 'lines',
          interactive: false,
        }).addTo(p.lineLayer)
        p.linePolys.push({ poly, center, offset: offsetPx(line) })
      }
      this._renderLineOffsets()
      this._applyConnectionStyle()
      this._buildStationDots()
    },

    _renderLineOffsets() {
      const p = _p.get(this)
      if (!p?.map) return
      for (const lp of p.linePolys) {
        lp.poly.setLatLngs(offsetLatLngs(p.map, lp.center, lp.offset))
      }
    },

    _renderUserPin(lat: number, lon: number) {
      const p = _p.get(this)!
      if (!p.map) return
      if (!p.userPin) {
        p.userPin = L.marker([lat, lon], { icon: USER_PIN, interactive: false }).addTo(p.map)
        if (!p.hasZoomed) {
          p.hasZoomed = true
          this._setView(lat, lon, 15)
          this.centeredOnUser = true
        }
      } else {
        p.userPin.setLatLng([lat, lon])
      }
    },
  },

  async mounted() {
    _p.set(this, {
      map: null, userPin: null, stationMarkers: [],
      bridgeControls: null, hasZoomed: false, programmatic: false,
      trainLayer: null, trainTimer: null, countdownTimer: null, trainState: new Map(),
      trainMarkers: new Map(), lineLayer: null, linePolys: [], stationDots: [],
      connectionDots: [],
    })
    this._initMap()

    const self = this
    const controls = await initBridge({
      setStations(stations) { self.stations = stations },
      onStationChanged(station, distKm, selected) {
        self.currentStation = station
        self.currentDistKm = distKm
        self.isPinned = selected
      },
      onDistanceChanged(distKm) { self.currentDistKm = distKm },
      onPredictionsUpdated(trains) { self.trains = trains },
      onGpsPositionUpdated(lat, lon) {
        self.userLat = lat
        self.userLon = lon
      },
      onStatusChanged() {},
      onSplashTap() {
        _p.get(self)?.bridgeControls?.startLocation()
      },
      getIsPinned() { return self.isPinned },
      getCurrentStationCode() { return self.currentStation?.code ?? null },
    })
    _p.get(this)!.bridgeControls = controls
    controls.startLocation()

    // Load the line geometry and draw the route ribbons (always visible).
    try {
      await wmataClient.loadStandardRoutes()
      this._drawLines()
    } catch (err) {
      console.warn('Line geometry load failed:', err)
    }
  },

  beforeUnmount() {
    const p = _p.get(this)
    if (p) {
      if (p.trainTimer) clearInterval(p.trainTimer)
      if (p.countdownTimer) clearInterval(p.countdownTimer)
      p.bridgeControls?.destroy()
      p.map?.remove()
    }
  },
})
</script>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
html,
body,
#app {
  height: 100%;
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--c-bg);
  color: var(--c-text);
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.map-wrap {
  position: relative;
  height: 55vh;
  flex-shrink: 0;
}
/* Live view: hide the boarding panel and let the map fill the screen. */
.app.live .map-wrap {
  height: auto;
  flex: 1;
}
.app.live .panel {
  display: none;
}
/* Searching takes over everything below the field, rather than dropping a list
   over the map. Hiding the map outright means Leaflet loses its container size
   while it is away, so the searchOpen watcher calls invalidateSize on the way
   back or the map returns blank. */
.app.searching .map-wrap,
.app.searching .panel {
  display: none;
}
.map {
  position: absolute;
  inset: 0;
  /* Own stacking context so Leaflet's high-z panes stay contained below the
     panel (z-index 1) where they overlap it. */
  z-index: 0;
  background: var(--c-bg);
}
.leaflet-container {
  background: var(--c-bg);
}
/* The basemap credit: required, but kept quiet. It sits in the corner, inside the
   --sp-3 gutter beneath the info button, so it must stay exactly that tall. */
.leaflet-control-attribution.leaflet-control {
  margin: 0;
  padding: 0 6px;
  border-top-right-radius: 4px;
  background: rgba(238, 238, 238, 0.7);
  color: var(--c-text-fainter);
  font-size: 9px;
  line-height: var(--sp-3);
}

.info-btn {
  position: absolute;
  left: var(--sp-3);
  bottom: var(--sp-3);
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 var(--sp-3) 0 var(--sp-2);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-control);
  background: var(--c-surface);
  color: var(--c-text-dim);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.info-ic {
  display: flex;
  color: var(--c-text);

  & svg {
    width: 15px;
    height: 15px;
    display: block;
  }
}

.update-counter {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 500;
  padding: 6px var(--sp-3);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-control);
  background: var(--c-surface);
  color: var(--c-text-dim);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.live-btn {
  position: absolute;
  right: 70px;
  bottom: var(--sp-3);
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 var(--sp-5);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-control);
  background: var(--c-surface);
  color: var(--c-live);
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  cursor: pointer;

  &.active {
    background: var(--c-live);
    border-color: var(--c-live);
    color: var(--c-surface);
  }
}
.live-dot {
  display: flex;
  flex-shrink: 0;
  color: var(--c-live);

  & svg {
    width: 18px;
    height: 18px;
    display: block;
  }
}
.live-btn.active .live-dot {
  color: var(--c-surface);
}
.train-arrow {
  width: 26px;
  height: 26px;
  transform-origin: center;

  & svg {
    display: block;
  }
}
.station-dot {
  cursor: pointer;

  & svg {
    display: block;
  }
}

.train-marker {
  transition: 335ms linear all;
}

/* Station name tooltip. Leaflet ships a light theme for these, so every
   property it sets has to be answered or the tooltip arrives white. */
.station-tip.leaflet-tooltip {
  background: var(--c-surface-raised);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-xs);
  color: var(--c-text-soft);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: 4px 8px;

  /* The callout arrow is a bordered pseudo-element, coloured independently of
     the bubble, so it stays light unless it is set too. */
  &.leaflet-tooltip-top::before { border-top-color: var(--c-surface-raised); }
  &.leaflet-tooltip-bottom::before { border-bottom-color: var(--c-surface-raised); }
  &.leaflet-tooltip-left::before { border-left-color: var(--c-surface-raised); }
  &.leaflet-tooltip-right::before { border-right-color: var(--c-surface-raised); }
}

/* Tap-a-train popup (dark theme — scoped class beats Leaflet's defaults) */
.train-popup-wrap {
  & .leaflet-popup-content-wrapper {
    background: var(--c-surface-raised);
    color: var(--c-text-soft);
    border: 1px solid var(--c-border-soft);
    border-radius: var(--r-sm);
  }
  & .leaflet-popup-content {
    margin: 10px 14px;
  }
  & .leaflet-popup-tip {
    background: var(--c-surface-raised);
    border: 1px solid var(--c-border-soft);
  }
  & .leaflet-popup-close-button {
    color: var(--c-text-fainter);
  }
}
.train-popup {
  & .tp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
    color: var(--c-text);
  }
  & .tp-icon {
    width: 26px;
    height: 26px;
    display: block;
    flex-shrink: 0;
  }
  & .tp-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--c-text-faint);
  }
}

.loc-btn {
  position: absolute;
  right: var(--sp-3);
  bottom: var(--sp-3);
  z-index: 500;
  width: 48px;
  height: 48px;
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-control);
  background: var(--c-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.loc-ic {
  display: flex;
  align-items: center;
  justify-content: center;

  & svg {
    width: 28px;
    height: 28px;
    display: block;
  }
}
</style>
