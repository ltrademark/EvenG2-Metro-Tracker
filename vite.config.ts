import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [vue()],
    define: {
      __WMATA_KEY__: JSON.stringify(env.WMATA_API_KEY ?? ''),
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
    },
    server: {
      port: 5173,
      strictPort: true,
      watch: {
        // WSL2 on Windows filesystem (/mnt/c/) requires polling — inotify doesn't fire
        usePolling: true,
        interval: 500,
      },
    },
  }
})
