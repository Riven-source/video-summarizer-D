import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // [LOG] 主进程入口
        entry: 'electron/main.ts',
        onstart(args) {
          // [LOG] 主进程启动完成
          console.log('[LOG] [Vite] Electron main process starting:', args)
          args.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'electron/main.ts',
              formats: ['cjs'],
              fileName: () => 'main.js'
            },
            rollupOptions: {
              external: ['electron'],
              output: {
                entryFileNames: 'main.js'
              }
            },
          },
        },
      },
      {
        // [LOG] 预加载脚本入口
        entry: 'electron/preload.ts',
        onstart(args) {
          // [DEBUG] 预加载脚本已编译
          console.log('[DEBUG] [Vite] Preload script compiled')
          // 通知渲染进程重新加载
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'electron/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.js'
            },
            rollupOptions: {
              external: ['electron'],
              output: {
                entryFileNames: 'preload.js'
              }
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
