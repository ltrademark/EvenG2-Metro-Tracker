<template>
  <div class="search-wrap" :class="{ open }">
    <div class="searchbar">
      <span class="search-ic" v-html="icSearchRaw"></span>
      <input
        ref="input"
        v-model="query"
        class="search-input"
        type="text"
        placeholder="Search Stations..."
        @focus="open = true"
        @blur="onBlur"
      />
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
import icSearchRaw from '../assets/web_app_icon-search.svg?raw'

export default defineComponent({
  name: 'SearchBar',
  components: { LineIcon },
  props: {
    stations: { type: Array as PropType<Station[]>, default: () => [] },
  },
  emits: ['select', 'open-change'],
  data() {
    return { query: '', open: false, icSearchRaw }
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
  watch: {
    open(v: boolean) {
      this.$emit('open-change', v)
    },
  },
  methods: {
    select(station: Station) {
      this.$emit('select', station)
      this.query = ''
      this.open = false
      ;(this.$refs.input as HTMLInputElement)?.blur()
    },
    onBlur() {
      // Delay so a result tap registers before the list closes.
      setTimeout(() => { this.open = false }, 120)
    },
  },
})
</script>

<style scoped>
/* First element in our viewport: the title bar above it belongs to the Even
   Realities host, not to this app. */
.search-wrap {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-2);
}
/* While results are up this owns the rest of the screen, so the list can scroll
   inside it instead of the page scrolling as a whole. */
.search-wrap.open {
  flex: 1;
}
.searchbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 32px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  border-radius: 6px;
  background: var(--c-field);
  color: var(--c-field-ink);
}
.search-ic {
  display: flex;
  flex-shrink: 0;

  /* :deep, because v-html markup carries no scope attribute for a plain selector
     to match, so a bare `svg` rule here would silently do nothing. */
  & :deep(svg) {
    width: 16px;
    height: 16px;
    display: block;
  }
}
.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-size: var(--fs-lg);

  &::placeholder {
    color: inherit;
  }
}
.results {
  list-style: none;
  margin: var(--sp-2) 0 0;
  border-radius: var(--r-xs);
  background: var(--c-surface);
  /* Only as tall as its contents, so a short result set does not leave a big
     empty white slab the way a fixed height would. */
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.result {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  cursor: pointer;

  &:active {
    background: var(--c-surface-hover);
  }
}
.result + .result {
  border-top: 1px solid var(--c-border-subtle);
}
.result-name {
  flex: 1;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
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
