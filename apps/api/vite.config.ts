import { defineConfig } from 'vite'

// Сборка сервера в один файл dist/index.js. Пакеты npm остаются внешними (ставятся в образ),
// пакеты рабочего пространства (@alpi/*) отдают исходники TypeScript и встраиваются в сборку.
export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    outDir: 'dist',
    target: 'node22',
    rollupOptions: {
      output: { entryFileNames: 'index.js' },
    },
  },
  ssr: {
    noExternal: [/^@alpi\//],
  },
})
