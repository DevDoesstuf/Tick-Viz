import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  worker: {
    // The ingest worker is authored in TS and imported via
    // `new Worker(new URL(...), { type: 'module' })` -- this format
    // lets Vite bundle/HMR it like any other module rather than treating
    // it as a static asset.
    format: 'es',
  },
});
