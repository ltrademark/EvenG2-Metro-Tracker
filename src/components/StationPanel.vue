<template>
  <section class="panel">
    <template v-if="station">
      <header class="panel-head">
        <div class="kicker">{{ isPinned ? 'Selected Station' : 'Current Station' }}</div>
        <div class="name-row">
          <img v-if="isPinned" :src="pinMono" class="sel-pin" alt="" />
          <h1 class="name">{{ station.name }}</h1>
        </div>
        <div v-if="showDistance" class="dist">{{ distanceMi }} mi away</div>
      </header>
      <div class="list-scroll">
        <TrainList :trains="trains" />
      </div>
    </template>

    <div v-else class="empty">
      <img :src="locOff" alt="" class="empty-icon" />
      <p class="empty-primary">Waiting for Location lock</p>
      <p class="empty-or">or</p>
      <p class="empty-secondary">Tap a Station on the map<br />to view Boarding Times</p>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import type { Station, Train } from '../wmata'
import TrainList from './TrainList.vue'
import locOff from '../assets/location-state_off.svg'
import pinMono from '../assets/Pindrop_mono.svg'

export default defineComponent({
  name: 'StationPanel',
  components: { TrainList },
  props: {
    station: { type: Object as PropType<Station | null>, default: null },
    isPinned: { type: Boolean, default: false },
    distKm: { type: Number, default: 0 },
    hasGps: { type: Boolean, default: false },
    trains: { type: Array as PropType<Train[]>, default: () => [] },
  },
  data() {
    return { locOff, pinMono }
  },
  computed: {
    distanceMi(): string {
      return (this.distKm * 0.621371).toFixed(1)
    },
    // Only meaningful with a GPS fix and when the user isn't standing at it.
    showDistance(): boolean {
      return this.hasGps && this.distKm * 0.621371 >= 0.05
    },
  },
})
</script>

<style scoped>
.panel {
  --corner-rounding: 25px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, var(--c-panel-top) 0%, var(--c-panel-bottom) 100%);
  border-top: 1px solid var(--c-border);
  border-radius: var(--corner-rounding) var(--corner-rounding) 0 0;
  position: relative;
  z-index: 1;
}
.panel-head {
  --pin-size: 18px;
  flex-shrink: 0;
  text-align: center;
  padding: 20px;
  border-bottom: 1px solid var(--c-border);
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.kicker {
  font-size: 13px;
  color: var(--c-text-fainter);
  margin-bottom: 4px;
}
.name-row {
  position: relative;
  &:has(.sel-pin) {
    padding: 0 calc(var(--pin-size) + 20px);
  }
}
.sel-pin {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: var(--pin-size);
  height: auto;
}
.name {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--c-text);
  text-wrap: balance;
  line-height: 1.1;
}
.dist {
  font-size: 14px;
  color: var(--c-text-fainter);
  margin-top: 6px;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 8px;
}
.empty-icon {
  width: 34px;
  height: 34px;
  opacity: 0.85;
  margin-bottom: 8px;
}
.empty-primary {
  font-size: 20px;
  font-weight: 600;
  color: var(--c-text-muted);
}
.empty-or {
  font-size: 14px;
  color: var(--c-text-faintest);
}
.empty-secondary {
  font-size: 18px;
  font-weight: 500;
  color: var(--c-text-muted);
  line-height: 1.35;
}
</style>
