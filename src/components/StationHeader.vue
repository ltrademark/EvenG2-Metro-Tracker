<template>
  <div class="station-header">
    <div class="name">
      <span v-if="isPinned" class="pin-label">[Pinned]</span>
      <span>{{ displayName }}</span>
    </div>
    <button v-if="isPinned" class="auto-btn" @click="$emit('unpin')">Auto</button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import type { Station } from '../wmata'

export default defineComponent({
  name: 'StationHeader',
  emits: ['unpin'],
  props: {
    station: {
      type: Object as PropType<Station | null>,
      default: null,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    displayName(): string {
      return this.station?.name ?? 'Locating…'
    },
  },
})
</script>

<style scoped>
.station-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px;
  background: #0f0f0f;
  border-bottom: 1px solid rgba(17, 85, 238, 0.25);
  flex-shrink: 0;
  gap: 8px;
}
.name {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pin-label {
  font-size: 10px;
  color: #4488ff;
  font-weight: 600;
  flex-shrink: 0;
  letter-spacing: 0.03em;
}
.auto-btn {
  background: transparent;
  color: #1155ee;
  border: 1px solid #1155ee;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}
.auto-btn:hover {
  background: rgba(17, 85, 238, 0.12);
}
</style>
