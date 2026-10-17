import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], server: { host: '0.0.0.0', proxy: { '/ws': { target: 'ws://localhost:3001', ws: true }, '/api': 'http://localhost:3001', '/health': 'http://localhost:3001' } } })
