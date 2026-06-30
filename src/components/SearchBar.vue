<template>
  <div class="search-wrap">
    <div class="searchbar" :class="{ active: open }">
      <img :src="icSearch" class="search-ic" alt="" />
      <input
        ref="input"
        v-model="query"
        class="search-input"
        type="text"
        placeholder="Search Stations…"
        @focus="open = true"
        @blur="onBlur"
      />
      <button class="chevron-btn" @mousedown.prevent @click="toggle" aria-label="Toggle list">
        <img :src="icDropdown" class="search-chevron" alt="" />
      </button>
    </div>

    <ul v-if="open && results.length" class="results">
      <li
        v-for="s in results"
        :key="s.code"
        class="result"
        @mousedown.prevent="select(s)"
      >
        <span class="result-name">{{ s.name }}</span>
        <span class="result-lines">
          <LineIcon v-for="ln in s.lines" :key="ln" :line="ln" />
        </span>
      </li>
    </ul>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import type { Station } from '../wmata'
import LineIcon from './LineIcon.vue'
import icSearch from '../assets/web_app_icon-search.svg'
import icDropdown from '../assets/web_app_icon-dropdown.svg'

export default defineComponent({
  name: 'SearchBar',
  components: { LineIcon },
  props: {
    stations: { type: Array as PropType<Station[]>, default: () => [] },
  },
  emits: ['select'],
  data() {
    return { query: '', open: false, icSearch, icDropdown }
  },
  computed: {
    results(): Station[] {
      const q = this.query.trim().toLowerCase()
      const matched = q
        ? this.stations.filter(s => s.name.toLowerCase().includes(q))
        : this.stations
      // Transfer stations appear once per platform code (same name) — collapse
      // them into a single result with the union of their lines.
      const byName = new Map<string, Station>()
      for (const s of matched) {
        const ex = byName.get(s.name)
        if (ex) {
          for (const ln of s.lines) if (!ex.lines.includes(ln)) ex.lines.push(ln)
        } else {
          byName.set(s.name, { ...s, lines: [...s.lines] })
        }
      }
      // Prioritise prefix matches, then alphabetical.
      return [...byName.values()]
        .sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
          return ap - bp || a.name.localeCompare(b.name)
        })
        .slice(0, 40)
    },
  },
  methods: {
    select(station: Station) {
      this.$emit('select', station)
      this.query = ''
      this.open = false
      ;(this.$refs.input as HTMLInputElement)?.blur()
    },
    toggle() {
      this.open = !this.open
      if (this.open) (this.$refs.input as HTMLInputElement)?.focus()
    },
    onBlur() {
      // Delay so a result tap registers before the list closes.
      setTimeout(() => { this.open = false }, 120)
    },
  },
})
</script>

<style scoped>
.search-wrap {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  z-index: 600;
}
.searchbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 8px 0 16px;
  border-radius: 26px;
  background: rgba(20, 20, 20, 0.9);
  border: 1px solid #2a2a2a;
  backdrop-filter: blur(8px);
}
.searchbar.active {
  background: rgba(17, 85, 238, 0.18);
  border-color: #1155ee;
}
.search-ic {
  width: 20px;
  height: 20px;
  opacity: 0.8;
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: #fff;
  font-size: 17px;
}
.search-input::placeholder {
  color: #8a8a8a;
  font-style: italic;
}
.chevron-btn {
  background: transparent;
  border: none;
  padding: 8px;
  cursor: pointer;
  display: flex;
  flex-shrink: 0;
}
.search-chevron {
  width: 12px;
  height: 12px;
  opacity: 0.6;
}
.results {
  list-style: none;
  margin: 8px 0 0;
  border-radius: 16px;
  background: rgba(12, 12, 12, 0.97);
  border: 1px solid #242424;
  backdrop-filter: blur(8px);
  max-height: 46vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  box-shadow: 0 10px 20px -5px rgba(0,0,0,0.65);
}
.result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  cursor: pointer;
}
.result:active {
  background: rgba(17, 85, 238, 0.18);
}
.result + .result {
  border-top: 1px solid #1b1b1b;
}
.result-name {
  flex: 1;
  font-size: 17px;
  font-weight: 600;
  color: #f2f2f2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-lines {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
