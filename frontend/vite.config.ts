import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api':          'http://localhost:8880',
      '/history':      'http://localhost:8880',
      '/topology.json':'http://localhost:8880',
      '/health':       'http://localhost:8880',
    }
  }
})