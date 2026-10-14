import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the API runs on :8000 and is proxied, so VITE_API_URL can stay empty.
// API_PROXY points the dev server at a different backend (e.g. a throwaway test one).
const apiTarget = process.env.API_PROXY ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/media': apiTarget,
    },
  },
})
