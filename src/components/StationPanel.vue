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
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, #0f0f0f 0%, #272727 100%);
  border-top: 1px solid #464646;
  border-radius: 50px 50px 0 0;
  /* Sit above the map, which extends behind this panel's rounded top. */
  position: relative;
  z-index: 1;
}
.panel-head {
  flex-shrink: 0;
  text-align: center;
  padding: 18px 20px 16px;
  border-bottom: 1px solid #464646;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.kicker {
  font-size: 13px;
  color: #7a7a7a;
  margin-bottom: 4px;
}
.name-row {
  position: relative;
}
.sel-pin {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  height: 30px;
  width: auto;
}
.name {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: #fff;
  line-height: 1.1;
}
.dist {
  font-size: 14px;
  color: #7a7a7a;
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
  color: #f2f2f2;
}
.empty-or {
  font-size: 14px;
  color: #6a6a6a;
}
.empty-secondary {
  font-size: 18px;
  font-weight: 500;
  color: #f2f2f2;
  line-height: 1.35;
}
</style>
