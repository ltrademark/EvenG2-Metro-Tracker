<template>
  <img :src="src" :alt="alt" class="line-icon" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { lineIconUrl } from '../lineIcons'

export default defineComponent({
  name: 'LineIcon',
  props: {
    line: { type: String, default: '' },
  },
  computed: {
    src(): string {
      return lineIconUrl(this.line)
    },
    alt(): string {
      return this.line || 'No Passenger'
    },
  },
})
</script>

<style scoped>
.line-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: block;
}
</style>
