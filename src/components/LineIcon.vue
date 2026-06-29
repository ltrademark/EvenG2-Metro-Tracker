<template>
  <img :src="src" :alt="alt" class="line-icon" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import Red from '../assets/Line_Red.svg'
import Blue from '../assets/Line_Blue.svg'
import Orange from '../assets/Line_Orange.svg'
import Silver from '../assets/Line_Silver.svg'
import Green from '../assets/Line_Green.svg'
import Yellow from '../assets/Line_Yellow.svg'
import NoPassenger from '../assets/Line_No Passenger.svg'

const LINE_SVG: Record<string, string> = {
  RD: Red,
  BL: Blue,
  OR: Orange,
  SV: Silver,
  GR: Green,
  YL: Yellow,
}

export default defineComponent({
  name: 'LineIcon',
  props: {
    line: { type: String, default: '' },
  },
  computed: {
    src(): string {
      // Out-of-service / no-line trains (e.g. "No Passenger") fall back to the
      // slash glyph.
      return LINE_SVG[this.line?.toUpperCase()] ?? NoPassenger
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
