import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          worker: resolve('src/main/worker.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    base: './',
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    plugins: [
      react(),
      {
        name: 'local-development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          // React Refresh needs its inline preamble and Vite uses a local socket.
          // The production HTML keeps its stricter policy.
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace(
              "connect-src 'none'",
              "connect-src 'self' ws://127.0.0.1:5173",
            )
        },
      },
    ],
    build: {
      minify: true,
    },
  },
})
