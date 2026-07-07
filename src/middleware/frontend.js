'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

/*
 * Serves the built React/Vite frontend from a sibling `frontend/dist` folder.
 *
 * Two-piece setup:
 *   1) express.static for hashed assets (cached aggressively)
 *   2) a catch-all that returns index.html for non-/api routes (SPA fallback)
 *
 * This must be mounted AFTER `/api` routes and AFTER `/health` so the API
 * always wins. The SPA fallback explicitly rejects anything under `/api/*`
 * so a bad API call returns JSON 404 from the API's own notFound handler,
 * not the HTML shell (which would confuse the frontend's fetch wrapper).
 *
 * If the build doesn't exist (developer hasn't run `npm run build:frontend`),
 * mountFrontend() logs once and skips, so the backend can still serve `/api`
 * cleanly. Pure-API local dev still works.
 */

const FRONTEND_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');

function indexHtmlExists() {
  try { return fs.statSync(INDEX_HTML).isFile(); } catch { return false; }
}

function mountFrontend(app) {
  if (!indexHtmlExists()) {
    console.warn('[frontend] no build found at', FRONTEND_DIR, '— API-only mode');
    return false;
  }
  console.log('[frontend] serving SPA from', FRONTEND_DIR);

  // 1) Hashed assets: long-lived, immutable. Vite emits files like
  //    /assets/index-aB12cD.js — the hash flips on every change, so we
  //    can cache for a year.
  app.use(
    '/assets',
    express.static(path.join(FRONTEND_DIR, 'assets'), {
      maxAge: '1y',
      immutable: true,
      index: false,
      fallthrough: true,
    })
  );

  // 2) Other static files at the root (favicon.svg, robots.txt, etc).
  //    No long cache — these are referenced by URL from index.html.
  app.use(
    express.static(FRONTEND_DIR, {
      index: false,            // don't auto-serve index.html here; we do it ourselves
      maxAge: 0,
      fallthrough: true,
      setHeaders: (res, filePath) => {
        // index.html should never be cached: a deploy invalidates the
        // asset hashes it references.
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    })
  );

  // 3) SPA fallback. Anything that's not /api and not a known static file
  //    serves index.html so React Router can pick up the route.
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    // Only GET should fall through to the SPA. POST/PUT/DELETE to unknown
    // routes should hit notFound and return JSON. We're already inside
    // app.get(...) so this is automatic — left this comment as a marker.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(INDEX_HTML, (err) => {
      if (err) next(err);
    });
  });

  return true;
}

module.exports = { mountFrontend, FRONTEND_DIR };
