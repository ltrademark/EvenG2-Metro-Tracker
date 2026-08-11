<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="card" role="dialog" aria-modal="true">
      <header class="card-head">
        <button class="close" @click="$emit('close')" aria-label="Close">✕</button>
        <span class="app-icon" v-html="appIconRaw"></span>
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
          <span class="ltm" v-html="ltmLogoRaw"></span>
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
import appIconRaw from '../assets/app-icon.svg?raw'
import ltmLogoRaw from '../assets/LTM-Logo.svg?raw'

export default defineComponent({
  name: 'InfoModal',
  emits: ['close'],
  data() {
    return {
      appIconRaw,
      ltmLogoRaw,
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
  padding: var(--sp-8);
}
.card {
  width: 100%;
  max-width: 380px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-dropdown);
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
  display: block;
  width: 56px;
  margin: 0 auto var(--sp-3);
  color: var(--c-text);

  /* :deep, because v-html markup gets no scope attribute for a plain selector
     to match. Without it the icon renders at its intrinsic 250px. */
  & :deep(svg) {
    width: 56px;
    height: 56px;
    display: block;
  }
}
.app-name {
  font-size: var(--fs-3xl);
  font-weight: var(--fw-heavy);
  color: var(--c-text);
}
.app-desc {
  font-size: var(--fs-md);
  color: var(--c-text-faintest);
  margin-top: var(--sp-1);
  text-wrap: balance;
}
.body {
  padding: 20px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.whatsnew {
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  color: var(--c-text);
  margin-bottom: var(--sp-3);
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
  padding-left: var(--sp-5);
  font-size: var(--fs-md);
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
  display: flex;
  flex-shrink: 0;
  color: var(--c-text-dim);

  & :deep(svg) {
    width: 20px;
    height: 20px;
    display: block;
  }
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
