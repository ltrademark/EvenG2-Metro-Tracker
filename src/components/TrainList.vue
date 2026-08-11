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
      // Min is not reliably a number. Near closing WMATA returns it empty, and it
      // can also be "---" or "DLY", all of which rendered as a bare "min".
      const n = parseInt(min, 10)
      return isNaN(n) ? (min.trim() || '--') : `${n} min`
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
  gap: 6px;
  padding: 0 var(--sp-2) var(--sp-4);
}
.empty {
  padding: var(--sp-7);
  text-align: center;
  color: var(--c-text-ghost);
  font-size: var(--fs-md);
}
/* Each arrival is its own card rather than a row in a divided list, which is what
   gives the panel its rhythm against the grey page behind it. */
.train-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-4);
  height: 45px;
  background: var(--c-surface);
  border-radius: var(--r-xs);
  box-shadow: var(--shadow-card);
}
.dest {
  flex: 1;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eta {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--c-text-faint);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;

  &.soon {
    color: var(--c-soon);
  }
}
</style>
