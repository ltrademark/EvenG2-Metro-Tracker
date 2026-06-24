<template>
  <div class="app-layout">
    <div ref="mapEl" class="map-pane"></div>
    <aside class="sidebar">
      <StationHeader :station="currentStation" :is-pinned="isPinned" @unpin="unpin" />
      <TrainList :trains="trains" />
      <div class="status-bar">{{ statusText }}</div>
    </aside>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import * as L from 'leaflet'
import { initBridge } from './bridge'
import type { BridgeControls } from './bridge'
import type { Station, Train } from './wmata'
import StationHeader from './components/StationHeader.vue'
import TrainList from './components/TrainList.vue'

const LINE_COLORS: Record<string, string> = {
  RD: '#E51636',
  BL: '#0063A6',
  OR: '#E47E00',
  SV: '#919D9D',
  GR: '#09801A',
  YL: '#FFD200',
}

// Non-reactive Leaflet/bridge state keyed by component instance
type Private = {
  map: L.Map | null
  userMarker: L.CircleMarker | null
  stationMarkers: L.CircleMarker[]
  bridgeControls: BridgeControls | null
}
const _p = new WeakMap<object, Private>()

export default defineComponent({
  name: 'App',
  components: { StationHeader, TrainList },

  data() {
    return {
      stations: [] as Station[],
      trains: [] as Train[],
      currentStation: null as Station | null,
      currentDistKm: 0,
      userLat: null as number | null,
      userLon: null as number | null,
      isPinned: false,
      statusText: 'Starting…',
    }
  },

  watch: {
    stations(newStations: Station[]) {
      if (newStations.length > 0) this._placeStationMarkers()
    },
    userLat() {
      if (this.userLat !== null && this.userLon !== null) {
        this._moveUserDot(this.userLat, this.userLon)
      }
    },
    userLon() {
      if (this.userLat !== null && this.userLon !== null) {
        this._moveUserDot(this.userLat, this.userLon)
      }
    },
  },

  methods: {
    unpin() {
      this.isPinned = false
      _p.get(this)?.bridgeControls?.unpin()
    },

    pinStation(code: string) {
      this.isPinned = true
      _p.get(this)?.bridgeControls?.pinStation(code)
    },

    _initMap() {
      const el = this.$refs.mapEl as HTMLElement
      const map = L.map(el).setView([38.9072, -77.0369], 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)
      _p.get(this)!.map = map
    },

    _placeStationMarkers() {
      const p = _p.get(this)!
      if (!p.map) return
      for (const station of this.stations) {
        const color = station.lines[0] ? (LINE_COLORS[station.lines[0]] ?? '#888') : '#888'
        const marker = L.circleMarker([station.lat, station.lon], {
          radius: 6,
          color: '#fff',
          fillColor: color,
          fillOpacity: 1,
          weight: 2,
        })
          .bindTooltip(station.name)
          .addTo(p.map)
        marker.on('click', () => this.pinStation(station.code))
        p.stationMarkers.push(marker)
      }
    },

    _moveUserDot(lat: number, lon: number) {
      const p = _p.get(this)!
      if (!p.map) return
      if (!p.userMarker) {
        p.userMarker = L.circleMarker([lat, lon], {
          radius: 9,
          color: '#fff',
          fillColor: '#4285F4',
          fillOpacity: 0.9,
          weight: 3,
        }).addTo(p.map)
      } else {
        p.userMarker.setLatLng([lat, lon])
      }
    },
  },

  async mounted() {
    _p.set(this, { map: null, userMarker: null, stationMarkers: [], bridgeControls: null })
    this._initMap()

    const self = this
    const controls = await initBridge({
      setStations(stations) {
        self.stations = stations
      },
      onStationChanged(station, distKm) {
        self.currentStation = station
        self.currentDistKm = distKm
      },
      onPredictionsUpdated(trains) {
        self.trains = trains
      },
      onGpsPositionUpdated(lat, lon) {
        self.userLat = lat
        self.userLon = lon
      },
      onStatusChanged(text) {
        self.statusText = text
      },
      getIsPinned() {
        return self.isPinned
      },
      getCurrentStationCode() {
        return self.currentStation?.code ?? null
      },
    })
    _p.get(this)!.bridgeControls = controls
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
  background: #0d0d1a;
  color: #eee;
}
.app-layout {
  display: flex;
  height: 100vh;
}
.map-pane {
  flex: 1;
  min-width: 0;
}
.sidebar {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #12122a;
  border-left: 1px solid #222;
  overflow: hidden;
}
.status-bar {
  padding: 8px 12px;
  font-size: 11px;
  color: #666;
  border-top: 1px solid #1e1e3a;
  background: #0d0d1a;
  flex-shrink: 0;
}
</style>
