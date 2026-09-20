import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base -> funktioniert unter jedem GitHub-Pages-Unterpfad ohne Rebuild.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/maskable.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // TLE-Kataloge: schnell aus dem Cache, im Hintergrund erneuern.
            urlPattern: ({ url }) => url.hostname.endsWith('celestrak.org'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'tle-catalog',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 12 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        id: './',
        name: 'Orbital Atlas – Satelliten Live Tracker',
        short_name: 'Orbital Atlas',
        description:
          'Interaktiver 3D-Sternenatlas mit Echtzeit-Satellitenpositionen, AR-Modus und Überflug-Vorhersage.',
        lang: 'de',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#03060f',
        theme_color: '#03060f',
        categories: ['education', 'utilities', 'navigation'],
        icons: [
          { src: './icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: './icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
  },
});
