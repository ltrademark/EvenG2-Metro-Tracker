<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="card" role="dialog" aria-modal="true">
      <header class="card-head">
        <button class="close" @click="$emit('close')" aria-label="Close">✕</button>
        <img :src="appIcon" class="app-icon" alt="" />
        <h2 class="app-name">{{ name }}</h2>
        <p class="app-desc">{{ description }}</p>
      </header>

      <div class="body">
        <h3 class="whatsnew">What's new in <span class="ver">v{{ changelog.version }}</span></h3>
        <ul class="changes">
          <li v-for="(c, i) in changelog.changes" :key="i">{{ c }}</li>
        </ul>
      </div>

      <footer class="card-foot">
        <button class="attrib" @click="open('https://www.ltrademark.com')">
          <img :src="ltmLogo" class="ltm" alt="" />
          <span>Made with <span class="heart">♥</span> by Ltrademark</span>
        </button>
        <button class="report" @click="open(reportUrl)">Report a bug</button>
      </footer>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { APP_NAME, APP_DESCRIPTION } from '../version'
import { CHANGELOG } from '../changelog'
import appIcon from '../assets/app-icon.svg'
import ltmLogo from '../assets/LTM-Logo.svg'

export default defineComponent({
  name: 'InfoModal',
  emits: ['close'],
  data() {
    return {
      appIcon,
      ltmLogo,
      name: APP_NAME,
      description: APP_DESCRIPTION,
      changelog: CHANGELOG,
      reportUrl: 'https://github.com/ltrademark/EvenG2-Metro-Tracker/issues/new',
    }
  },
  methods: {
    open(url: string) {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  },
})
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--c-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.card {
  width: 100%;
  max-width: 380px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-xl);
  overflow: hidden;
}
.card-head {
  position: relative;
  text-align: center;
  padding: 20px;
  border-bottom: 1px solid var(--c-border-subtle);
}
.close {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--c-text-faint);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.app-icon {
  width: 96px;
  height: 96px;
  border-radius: var(--r-2xl);
  margin-bottom: 12px;
}
.app-name {
  font-size: 26px;
  font-weight: 800;
  color: var(--c-text);
}
.app-desc {
  font-size: 14px;
  color: var(--c-text-faint);
  margin-top: 4px;
  text-wrap: balance;
}
.body {
  padding: 20px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.whatsnew {
  font-size: 18px;
  font-weight: 700;
  color: var(--c-text);
  margin-bottom: 12px;
}
.ver {
  color: var(--c-soon);
}
.changes {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.changes li {
  position: relative;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-text-soft);

  &::before {
    content: '•';
    position: absolute;
    left: 4px;
    color: var(--c-text-faintest);
  }
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-top: 1px solid var(--c-border-subtle);
}
.attrib {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  color: var(--c-text-dim);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  & span {
    text-align: inherit;
  }
}
.ltm {
  width: 22px;
  height: 22px;
}
.heart {
  color: var(--c-heart);
}
.report {
  background: transparent;
  border: 1px solid var(--c-border);
  color: var(--c-text-muted);
  font-size: 14px;
  font-weight: 600;
  padding: 8px;
  border-radius: var(--r-xs);
  cursor: pointer;
  flex-shrink: 0;

  &:active {
    background: var(--c-surface-hover);
  }
}
</style>
