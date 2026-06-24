<template>
  <div class="train-list">
    <div v-if="trains.length === 0" class="empty">No arrivals found</div>
    <div v-for="(train, i) in trains" :key="i" class="train-row">
      <span class="badge" :style="{ background: lineColor(train.line) }">
        {{ train.line }}
      </span>
      <span class="dest">{{ train.destination }}</span>
      <span class="eta" :class="{ urgent: isUrgent(train.min) }">
        {{ formatEta(train.min) }}
      </span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import type { Train } from '../wmata'

const LINE_COLORS: Record<string, string> = {
  RD: '#E51636',
  BL: '#0063A6',
  OR: '#E47E00',
  SV: '#919D9D',
  GR: '#09801A',
  YL: '#FFD200',
}

export default defineComponent({
  name: 'TrainList',
  props: {
    trains: {
      type: Array as PropType<Train[]>,
      required: true,
    },
  },
  methods: {
    lineColor(line: string): string {
      return LINE_COLORS[line] ?? '#555'
    },
    formatEta(min: string): string {
      if (min === 'ARR') return 'ARR'
      if (min === 'BRD') return 'BRD'
      return `${min} min`
    },
    isUrgent(min: string): boolean {
      return min === 'ARR' || min === 'BRD' || min === '1' || min === '2'
    },
  },
})
</script>

<style scoped>
.train-list {
  flex: 1;
  overflow-y: auto;
}
.empty {
  padding: 24px;
  text-align: center;
  color: #555;
  font-size: 13px;
}
.train-row {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #1e1e3a;
  gap: 10px;
}
.train-row:hover {
  background: #1a1a35;
}
.badge {
  min-width: 32px;
  text-align: center;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
  color: #fff;
  flex-shrink: 0;
}
.dest {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eta {
  font-size: 12px;
  color: #888;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.eta.urgent {
  color: #4ade80;
  font-weight: 600;
}
</style>
