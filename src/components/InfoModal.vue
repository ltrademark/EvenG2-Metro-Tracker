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
  background: rgba(0, 0, 0, 0.65);
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
  background: #111;
  border: 1px solid #262626;
  border-radius: 18px;
  overflow: hidden;
}
.card-head {
  position: relative;
  text-align: center;
  padding: 20px;
  border-bottom: 1px solid #1e1e1e;
}
.close {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: #8a8a8a;
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.app-icon {
  width: 96px;
  height: 96px;
  border-radius: 22px;
  margin-bottom: 12px;
}
.app-name {
  font-size: 26px;
  font-weight: 800;
  color: #fff;
}
.app-desc {
  font-size: 14px;
  color: #8a8a8a;
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
  color: #fff;
  margin-bottom: 12px;
}
.ver {
  color: #3cd35c;
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
  color: #e2e2e2;
}
.changes li::before {
  content: '•';
  position: absolute;
  left: 4px;
  color: #6a6a6a;
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-top: 1px solid #1e1e1e;
}
.attrib {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  color: #cfcfcf;
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
  color: #e2533f;
}
.report {
  background: transparent;
  border: 1px solid #3a3a3a;
  color: #f2f2f2;
  font-size: 14px;
  font-weight: 600;
  padding: 8px;
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
}
.report:active {
  background: #1d1d1d;
}
</style>
