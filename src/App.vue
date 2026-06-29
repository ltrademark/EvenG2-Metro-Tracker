<template>
  <div class="app" :class="{ live: liveView }">
    <div class="map-wrap">
      <div ref="mapEl" class="map"></div>

      <SearchBar :stations="stations" @select="onSelectStation" />

      <!-- Version / info button -->
      <button class="info-btn" @click="showInfo = true">
        <img :src="icQuery" class="info-ic" alt="info" />
        <span class="info-ver">v{{ version }}</span>
      </button>

      <!-- Live View toggle (also the way back to the normal view) -->
      <button class="live-btn" :class="{ active: liveView }" @click="toggleLive">
        <span class="live-dot"></span>
        <span>Live View</span>
      </button>

      <!-- Recenter-on-location button -->
      <button class="loc-btn" @click="recenter" aria-label="My location">
        <img :src="locIcon" class="loc-ic" alt="" />
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
import { wmataClient } from './wmata'
import type { Station, Train } from './wmata'
import { APP_VERSION } from './version'
import StationPanel from './components/StationPanel.vue'
import SearchBar from './components/SearchBar.vue'
import InfoModal from './components/InfoModal.vue'
import icQuery from './assets/query icon.svg'
import locOff from './assets/location-state_off.svg'
import locOn from './assets/location-state_on.svg'
import pinUser from './assets/Pindrop.svg'

const LINE_COLORS: Record<string, string> = {
  RD: '#E51636',
  BL: '#0063A6',
  OR: '#E47E00',
  SV: '#919D9D',
  GR: '#09801A',
  YL: '#FFD200',
}

// Blue teardrop marking the user's GPS position (tip at the coordinate).
const USER_PIN = L.icon({ iconUrl: pinUser, iconSize: [40, 40], iconAnchor: [20, 38] })

// Fixed draw order for the parallel-ribbon offset — a line always sits on the
// same side relative to its neighbours. Offsets are in pixels (constant across
// zoom), so shared trunks render as evenly-spaced colored ribbons.
const LINE_ORDER = ['RD', 'OR', 'SV', 'BL', 'YL', 'GR']
const LINE_W = 3
const LINE_GAP = 1

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

// Placeholder live-train marker: a line-colored arrowhead rotated to its
// heading, shifted onto its line's ribbon (same pixel offset as the line).
function trainIcon(line: string, bearing: number): L.DivIcon {
  const color = LINE_COLORS[line] ?? '#888'
  const off = offsetPx(line)
  const rad = (bearing * Math.PI) / 180
  const ox = Math.cos(rad) * off // perpendicular to heading, matching offsetLatLngs
  const oy = Math.sin(rad) * off
  const html =
    `<div class="train-arrow" style="transform:rotate(${bearing}deg)">` +
    `<svg viewBox="0 0 20 20" width="20" height="20">` +
    `<path d="M10 1 L17 18 L10 14 L3 18 Z" fill="${color}" stroke="#0a0a0a" stroke-width="1.2"/>` +
    `</svg></div>`
  return L.divIcon({ html, className: 'train-marker', iconSize: [20, 20], iconAnchor: [10 - ox, 10 - oy] })
}

// Non-reactive Leaflet/bridge state keyed by component instance
type Private = {
  map: L.Map | null
  userPin: L.Marker | null
  stationMarkers: L.CircleMarker[]
  bridgeControls: BridgeControls | null
  hasZoomed: boolean
  programmatic: boolean
  trainLayer: L.LayerGroup | null
  trainTimer: ReturnType<typeof setInterval> | null
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
      locOff,
      locOn,
      icQuery,
    }
  },

  computed: {
    locIcon(): string {
      return this.userLat !== null && this.centeredOnUser ? this.locOn : this.locOff
    },
  },

  watch: {
    stations(newStations: Station[]) {
      if (newStations.length > 0) this._placeStationMarkers()
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
      p.trainTimer = setInterval(() => void this._pollTrains(), 15_000)
    },

    _stopLive() {
      const p = _p.get(this)
      if (!p) return
      if (p.trainTimer) { clearInterval(p.trainTimer); p.trainTimer = null }
      p.trainLayer?.clearLayers()
    },

    async _pollTrains() {
      const p = _p.get(this)
      if (!p?.map || !p.trainLayer) return
      try {
        const trains = await wmataClient.fetchTrainPositions()
        const placed = wmataClient.placeTrains(trains)
        p.trainLayer.clearLayers()
        for (const t of placed) {
          L.marker([t.lat, t.lon], { icon: trainIcon(t.line, t.bearing), interactive: false })
            .addTo(p.trainLayer)
        }
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
      p.map.setView([lat, lon], zoom)
    },

    _initMap() {
      const el = this.$refs.mapEl as HTMLElement
      const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([38.9072, -77.0369], 11)
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
      }).addTo(map)
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
      // Pixel offsets are zoom-dependent — recompute the ribbons after a zoom.
      map.on('zoomend', () => this._renderLineOffsets())
    },

    _placeStationMarkers() {
      const p = _p.get(this)!
      if (!p.map) return
      for (const station of this.stations) {
        // Uniform white dot with a black ring — the colored ribbon carries the
        // line identity now.
        const marker = L.circleMarker([station.lat, station.lon], {
          radius: 4,
          color: '#000',
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2,
        })
          .bindTooltip(station.name)
          .addTo(p.map)
        marker.on('click', () => this.pinStation(station.code))
        p.stationMarkers.push(marker)
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
          color: LINE_COLORS[line] ?? '#888',
          weight: LINE_W,
          opacity: 0.95,
          pane: 'lines',
          interactive: false,
        }).addTo(p.lineLayer)
        p.linePolys.push({ poly, center, offset: offsetPx(line) })
      }
      this._renderLineOffsets()
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
      trainLayer: null, trainTimer: null, lineLayer: null, linePolys: [],
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
  background: #0a0a0a;
  color: #eee;
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
.map {
  position: absolute;
  inset: 0;
  background: #0a0a0a;
}
.leaflet-container {
  background: #0a0a0a;
}

/* Version / info button */
.info-btn {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px 0 8px;
  border: none;
  border-radius: 18px;
  background: rgba(15, 15, 15, 0.9);
  color: #cfcfcf;
  font-size: 13px;
  cursor: pointer;
}
.info-ic {
  width: 22px;
  height: 22px;
}

/* Live View toggle */
.live-btn {
  position: absolute;
  right: 82px;
  bottom: 16px;
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 22px;
  border: none;
  border-radius: 26px;
  background: rgba(15, 15, 15, 0.92);
  color: #ff3b30;
  font-size: 17px;
  font-weight: 700;
  cursor: pointer;
}
.live-btn.active {
  background: #ff3b30;
  color: #fff;
}
.live-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ff3b30;
  flex-shrink: 0;
}
.live-btn.active .live-dot {
  background: #fff;
}
.train-arrow {
  width: 20px;
  height: 20px;
  transform-origin: center;
}

/* Location button */
.loc-btn {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 500;
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  background: rgba(15, 15, 15, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.loc-ic {
  width: 28px;
  height: 28px;
}
</style>
