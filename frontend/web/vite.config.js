import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, /oauth, /api and /health are proxied to the API Gateway so the browser never
// needs CORS and never learns internal service addresses.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/oauth': process.env.VITE_GATEWAY_URL || 'http://localhost:8080',
      '/api': process.env.VITE_GATEWAY_URL || 'http://localhost:8080',
      '/health': process.env.VITE_GATEWAY_URL || 'http://localhost:8080',
    },
  },
});
