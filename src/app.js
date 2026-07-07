'use strict';

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');

const config = require('./config');
const pool = require('./db/pool');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errors');
const { mountFrontend } = require('./middleware/frontend');

const app = express();

// Trust the first hop (Railway's edge proxy) so secure cookies + req.ip work.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: false, // managed by our migration
    }),
    name: config.COOKIE_NAME,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh expiry on every request
    cookie: {
      httpOnly: true,
      secure: config.IS_PROD, // HTTPS-only in prod
      sameSite: 'lax',
      maxAge: config.SESSION_TTL_MS,
    },
  })
);

// Liveness probe — Railway healthcheck target. Plain-text so it survives
// behind any caching layer.
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// API
app.use('/api', routes);

// Frontend SPA — must be mounted AFTER /api and AFTER /health so the API
// always wins. mountFrontend() is a no-op (with a warning log) if the
// build doesn't exist, keeping API-only local dev working.
mountFrontend(app);

// 404 + error. The SPA fallback above handles non-/api GETs; anything
// that reaches notFound is either an unmatched /api/* route or a
// non-GET method on a path the API doesn't handle — both should return
// JSON, which is what notFound does.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
