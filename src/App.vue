<template>
  <div class="app">
    <div class="map-wrap">
      <div ref="mapEl" class="map"></div>

      <SearchBar :stations="stations" @select="onSelectStation" />

      <!-- Version / info button -->
      <button class="info-btn" @click="showInfo = true">
        <img :src="icQuery" class="info-ic" alt="info" />
        <span class="info-ver">v{{ version }}</span>
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

// Non-reactive Leaflet/bridge state keyed by component instance
type Private = {
  map: L.Map | null
  userPin: L.Marker | null
  stationMarkers: L.CircleMarker[]
  bridgeControls: BridgeControls | null
  hasZoomed: boolean
  programmatic: boolean
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
      const p = _p.get(this)!
      p.map = map
      // Any user-driven move clears the "centered on me" state.
      map.on('movestart', () => {
        if (!p.programmatic) this.centeredOnUser = false
      })
      map.on('moveend', () => {
        p.programmatic = false
      })
    },

    _placeStationMarkers() {
      const p = _p.get(this)!
      if (!p.map) return
      for (const station of this.stations) {
        const color = station.lines[0] ? (LINE_COLORS[station.lines[0]] ?? '#888') : '#888'
        const marker = L.circleMarker([station.lat, station.lon], {
          radius: 5,
          color: '#0a0a0a',
          fillColor: color,
          fillOpacity: 1,
          weight: 1,
        })
          .bindTooltip(station.name)
          .addTo(p.map)
        marker.on('click', () => this.pinStation(station.code))
        p.stationMarkers.push(marker)
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
  },

  beforeUnmount() {
    const p = _p.get(this)
    if (p) {
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
