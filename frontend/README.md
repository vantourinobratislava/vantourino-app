# bratislavabike-quiz-app

Backend + integrated frontend for the Bratislava Bike live quiz app. One repo, one Railway service, one domain.

- **Domain:** `app.bratislavabiketour.com`
- **Hosting:** Railway (Node + Postgres)
- **Stack:** Node.js 20+, Express 4, PostgreSQL, React 18 + Vite (served by Express)

## What changed in v0.4.0

- Frontend source moved into `frontend/` (the standalone `bratislavabike-quiz-frontend` repo is now the dev copy; this is the deployable copy)
- Express serves the built SPA from `frontend/dist` alongside the existing API
- One origin in production → cookies "just work" with no CORS dance
- `GET /` is no longer a JSON status endpoint; it serves the SPA. Use `/health` for liveness.
- Local backend-only dev still works — if `frontend/dist` is missing, the server logs a warning and runs API-only.

Everything from v0.3.0 (quiz engine, scoring, all endpoints) is unchanged.

## Project layout

```
bratislavabike-quiz-app/
├── server.js
├── package.json                    (build:frontend script added)
├── README.md                       (this file)
├── src/
│   ├── app.js                      (mounts /api, then SPA, then notFound)
│   ├── config.js
│   ├── db/                         (unchanged)
│   ├── middleware/
│   │   ├── errors.js
│   │   ├── requireAdmin.js
│   │   └── frontend.js             ← new: serves frontend/dist with correct cache headers
│   ├── routes/                     (unchanged)
│   ├── services/                   (unchanged)
│   └── utils/                      (unchanged)
├── scripts/
│   └── create-admin.js
└── frontend/                       ← new: full frontend source
    ├── package.json
    ├── package-lock.json
    ├── vite.config.js
    ├── index.html
    ├── public/
    ├── src/
    └── dist/                       (generated; gitignored)
```

`frontend/node_modules`, `frontend/dist`, and `frontend/.env.local` are gitignored.

## How requests are routed

```
                            ┌─────────────────────────────────────────┐
GET /health                 │ app.get('/health')          → "OK"      │
                            ├─────────────────────────────────────────┤
GET /api/admin/me           │ app.use('/api', routes)     → JSON      │
POST /api/session/.../answer│                                          │
... any /api/*              │                                          │
                            ├─────────────────────────────────────────┤
GET /assets/index-HASH.js   │ express.static('/assets/')              │
GET /assets/index-HASH.css  │   Cache-Control: 1 year, immutable      │
                            ├─────────────────────────────────────────┤
GET /favicon.svg            │ express.static(FRONTEND_DIR)            │
                            │   Cache-Control: 0                      │
                            ├─────────────────────────────────────────┤
GET /                       │ SPA fallback → frontend/dist/index.html │
GET /admin/login            │   regex: ^(?!\/api(?:\/|$)).*           │
GET /play/K7XQ24            │   Cache-Control: no-cache, no-store     │
GET /anything-else          │                                          │
                            ├─────────────────────────────────────────┤
POST /unknown               │ notFound → JSON 404                     │
GET  /api/unknown           │   (SPA fallback won't match /api/*)     │
                            └─────────────────────────────────────────┘
```

Critical ordering rules embedded in `src/app.js`:

1. **`/api` is mounted before the SPA fallback.** So `/api/admin/me` reaches the API router and never falls through to the HTML shell.
2. **The SPA fallback regex explicitly excludes `/api/*`.** A missing API endpoint returns JSON 404, not HTML — so the frontend's fetch wrapper never sees HTML where it expects JSON.
3. **`notFound` runs last.** Anything reaching it is either an unmatched `/api/*` path or a non-GET to a path the API doesn't handle. Both should be JSON.
4. **`index.html` is never cached.** Asset filenames are hashed (`index-aB12cD.js`), so they can be cached for a year — but `index.html` references those hashes by name, and a deploy generates new hashes. Stale HTML would point at deleted files.

## React Router gotchas

React Router 6 uses HTML5 `pushState` URLs by default (`/admin/login`, not `/#/admin/login`). That means:

- **Direct navigation works.** A user typing `https://app.bratislavabiketour.com/admin/sessions/K7XQ24` hits the server with that path. The SPA fallback serves `index.html`, the React app boots, the router sees `/admin/sessions/K7XQ24` in `window.location`, and renders the right page.
- **Reloads work.** Same path, same fallback, same result.
- **QR-code deep links work.** A QR at `https://app.bratislavabiketour.com/join/K7XQ24` hits `index.html`, the SPA boots, and the team-join screen renders.

The one thing that breaks this is: **the SPA fallback serving `index.html` to an unintended path**. We avoid this two ways:

- `/api/*` is explicitly excluded.
- Static files exist at exact paths (`/favicon.svg`, `/assets/...`), and `express.static` serves them before the fallback regex runs.

If you ever add a new top-level path that should be an API (e.g. `/webhooks/stripe`), you have two options: mount it before the SPA, OR extend the regex. The current regex only excludes `/api`, so a webhook at `/webhooks/...` would currently get the SPA. Either move webhooks under `/api/webhooks/...` (recommended) or extend the regex in `src/middleware/frontend.js`.

## Cookies & auth

`SESSION_COOKIE_SAME_SITE=lax` and `secure=true` in production. With same-origin deployment:

- The cookie is set on `app.bratislavabiketour.com`.
- The frontend fetches `/api/admin/me` from the same origin.
- `sameSite=lax` permits the cookie on same-site requests (which a same-origin request always is).
- No CORS configuration needed. No preflight requests.

`credentials: 'include'` in the frontend's API client is harmless on same-origin requests and keeps the option open if the frontend is ever served from a different origin.

## Environment variables (Railway)

Unchanged from v0.3.0:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{ Postgres.DATABASE_URL }}` |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `NODE_ENV` | `production` |

No new variables. The frontend has no environment dependencies at runtime — its build is a static bundle.

## Build & deploy on Railway

Railway's nixpacks builder runs in two phases that we want to use:

1. **Install phase:** `npm install` (gets all backend deps, including devDependencies).
2. **Build phase:** Railway's "Build Command".
3. **Start phase:** `npm start` (default).

Configure these in the Railway service settings:

| Setting | Value |
|---|---|
| **Build Command** | `npm run build:frontend` |
| **Start Command** | `npm start` (or leave default) |
| **Pre-Deploy Command** | `npm run migrate` (unchanged) |
| **Healthcheck Path** | `/health` (unchanged) |

`npm run build:frontend` runs `cd frontend && npm ci && npm run build`. After Railway's build phase, `frontend/dist` exists and `server.js` serves it.

You don't need to commit `frontend/dist` — it's regenerated on every deploy. The `frontend/package-lock.json` IS committed, so `npm ci` is deterministic.

## GitHub update instructions

```bash
cd /path/to/bratislavabike-quiz-app
git checkout main
git pull
git checkout -b v4-fullstack-deploy

# Copy all files from /mnt/user-data/outputs/bratislavabike-quiz-app/ over
# your local repo. Existing files (package.json, README.md, src/app.js,
# .gitignore) get overwritten. New: src/middleware/frontend.js and the
# entire frontend/ directory.

# Verify locally
npm install
npm run build:frontend
node -e "require('./src/app.js'); console.log('boots');"

git add .
git commit -m "v4 fullstack: serve frontend from backend, single Railway service"
git push -u origin v4-fullstack-deploy

# Open a PR. After merge, the next Railway deploy will:
#   1. npm install      (backend deps)
#   2. npm run build:frontend   (builds frontend/dist)
#   3. npm run migrate  (no new migrations in v4)
#   4. npm start        (Express serves API + SPA from one process)
```

**Important:** Set the Railway **Build Command** to `npm run build:frontend` *before* you push. If you push without setting it, the deploy will succeed but `frontend/dist` won't exist, and the server will run in API-only mode. The fallback is intentional (so the API doesn't break), but the frontend will be missing.

## Keeping the standalone frontend repo in sync

You now have two copies of the frontend code: the standalone `bratislavabike-quiz-frontend` repo (good for frontend-only dev with hot reload) and the `frontend/` folder in this backend repo (what actually gets deployed).

Two reasonable patterns:

**(a) This repo is the source of truth.** Make all frontend changes in `bratislavabike-quiz-app/frontend/`. Periodically copy them to the standalone repo if you still use it. Or just retire the standalone repo.

**(b) Standalone repo is the source of truth.** Develop in the standalone repo with `npm run dev` + the Vite dev proxy. When ready, copy the source into `bratislavabike-quiz-app/frontend/` and push the backend repo.

I recommend **(a)** for simplicity — one repo, one place to look. The Vite dev server still works inside this repo:

```bash
cd /path/to/bratislavabike-quiz-app/frontend
npm install
npm run dev   # http://localhost:5173, proxies /api → app.bratislavabiketour.com
```

## Local test instructions

### Full-stack local test (everything from one Node process)

```bash
# From the backend repo root:
npm install
npm run build:frontend    # builds frontend/dist
PORT=3000 SESSION_SECRET=test node server.js
# → visit http://localhost:3000
#   - /                  → SPA landing
#   - /admin/login       → SPA admin login
#   - /api/admin/me      → JSON 401 (expected; no cookie)
#   - /health            → "OK"
```

### Pure backend-only (no frontend rebuild needed)

If you're iterating on backend code and don't want to rebuild the frontend:

```bash
rm -rf frontend/dist
npm run dev    # backend with --watch
# server logs "[frontend] no build found ... — API-only mode"
# /api/* works, SPA routes 404 (expected)
```

### Frontend hot-reload

```bash
cd frontend
npm install
npm run dev    # http://localhost:5173
# Vite proxies /api → https://app.bratislavabiketour.com so admin auth works
# against the production backend. Override with VITE_DEV_API_PROXY_TARGET.
```

## Things to watch out for

1. **First deploy: set the Build Command in Railway.** Without `npm run build:frontend` set as the build command, your deploy will succeed but ship without the frontend.

2. **Don't commit `frontend/dist/`.** It's gitignored. If you accidentally `git add frontend/` after building locally, double-check you're not also adding `dist/`. (`git add frontend/src frontend/package.json` etc. is safer than `git add frontend/`.)

3. **`/api/*` 404s must stay JSON.** If you ever change the SPA-fallback regex, test that `/api/something-unknown` still returns `{"error":"Not Found"}` and not HTML. The frontend's fetch wrapper expects JSON.

4. **Adding new top-level routes.** A new path like `/webhooks/stripe` won't match `/api`, so it'll currently fall through to the SPA. Mount any new external endpoints either under `/api/` or update the exclusion regex.

5. **CSP.** Helmet's default Content-Security-Policy is `script-src 'self'`, which is fine for the Vite production build. If you later add a third-party script (analytics, error tracker), you'll need to relax CSP — at that point, configure helmet's `contentSecurityPolicy` option explicitly rather than disabling it.

6. **Static asset cache + index.html.** `/assets/*` is cached for one year (immutable hashes). `index.html` is set to `no-cache, no-store, must-revalidate`. Don't change either without thinking through what happens after a deploy: stale `index.html` → references to deleted asset hashes → broken page.

7. **`trust proxy 1`.** Already set. Keeps secure cookies and `req.ip` correct behind Railway's edge. Don't remove it.

## Quick verification after deploy

```bash
DOMAIN=https://app.bratislavabiketour.com

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $DOMAIN/health
# → 200 text/plain; ...

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $DOMAIN/
# → 200 text/html; ...

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $DOMAIN/admin/login
# → 200 text/html; ...

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $DOMAIN/api/admin/me
# → 401 application/json; ...

curl -s -D - $DOMAIN/ | grep -i 'cache-control'
# → Cache-Control: no-cache, no-store, must-revalidate

# Hashed asset path (varies — extract from index.html)
ASSET=$(curl -s $DOMAIN/ | grep -oE '/assets/[^"]*\.js' | head -1)
curl -s -D - $DOMAIN$ASSET | grep -iE 'cache-control|content-type' | head -2
# → Cache-Control: public, max-age=31536000, immutable
# → Content-Type: application/javascript; charset=UTF-8
```
