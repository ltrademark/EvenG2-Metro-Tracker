<template>
  <div class="train-list">
    <div v-if="trains.length === 0" class="empty">No arrivals found</div>
    <div v-for="(train, i) in trains" :key="i" class="train-row">
      <LineIcon :line="train.line" />
      <span class="dest">{{ train.destination }}</span>
      <span class="eta" :class="{ soon: isSoon(train.min) }">{{ formatEta(train.min) }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import type { Train } from '../wmata'
import LineIcon from './LineIcon.vue'

export default defineComponent({
  name: 'TrainList',
  components: { LineIcon },
  props: {
    trains: { type: Array as PropType<Train[]>, required: true },
  },
  methods: {
    formatEta(min: string): string {
      if (min === 'ARR') return 'ARR'
      if (min === 'BRD') return 'BRD'
      return `${min} min`
    },
    isSoon(min: string): boolean {
      if (min === 'ARR' || min === 'BRD') return true
      const n = parseInt(min, 10)
      return !isNaN(n) && n <= 2
    },
  },
})
</script>

<style scoped>
.train-list {
  display: flex;
  flex-direction: column;
}
.empty {
  padding: 28px;
  text-align: center;
  color: #555;
  font-size: 14px;
}
.train-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid #464646;
}
.dest {
  flex: 1;
  font-size: 18px;
  font-weight: 600;
  color: #f2f2f2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eta {
  font-size: 16px;
  font-weight: 700;
  color: #8a8a8a;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.eta.soon {
  color: #3cd35c;
}
</style>
