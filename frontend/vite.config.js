import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// During `vite` (dev), proxy /api to the configured backend so the browser
// sees same-origin requests. This keeps cookies (sameSite=lax) working in dev
// without needing CORS on the backend.
//
// In production, the frontend can be served from any origin; for cross-origin
// deploys, configure CORS on the backend AND ensure the session cookie has
// sameSite=None; secure (currently it's sameSite=lax). Easiest path is to
// serve the frontend from the same origin as the backend.

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_DEV_API_PROXY_TARGET || 'https://app.bratislavabiketour.com';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: 'localhost',
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
