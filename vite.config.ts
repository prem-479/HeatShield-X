import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    host: '0.0.0.0',
    watch: {
      ignored: [
        '**/.venv/**',
        '**/.venv-heatshield/**',
        '**/node_modules/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
      ],
    },
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          charts: ['recharts'],
        },
      },
    },
  },
})
