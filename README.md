# bratislavabike-quiz-app

Backend for the Bratislava Bike live quiz app. Tour groups join a quiz session by scanning a QR code; an admin runs the session and walks the group through questions one at a time.

- **Domain:** `app.bratislavabiketour.com`
- **Hosting:** Railway (Node + Postgres)
- **Stack:** Node.js 20+, Express 4, PostgreSQL (`pg`), `express-session` + `connect-pg-simple`, `bcryptjs`, `helmet`

## What's in v0.3.0 — the quiz engine

- Quiz content model: `questions`, `answer_options` (single-choice MCQ)
- Session state machine on `quiz_sessions`: `pending → active → round_results → finished → closed`
- Per-current-question state machine: `not_started → live → closed`
- Per-team token issued at join, sent as `Authorization: Bearer <token>` for answer submission
- DB-enforced one-answer-per-team-per-question via `UNIQUE(session_id, question_id, team_id)`
- Atomic answer submission: only accepted while the question is live for that session
- `finishQuestion` is a single transaction: scoring, ranking, cumulative totals, round_results, final_results (if last), and session-status update all together
- Centralized status constants in `src/utils/statuses.js`

## Endpoints

### v2 endpoints (unchanged behavior)

```
GET  /health
GET  /
POST /api/admin/login
POST /api/admin/logout
GET  /api/admin/me
POST /api/admin/quiz-sessions             (now also accepts { quizId } in addition to { title })
GET  /api/admin/quiz-sessions/:sessionCode (response extended with questions[] and runtime state)
POST /api/session/:sessionCode/join        (response now also includes token)
```

### Admin (cookie-authed)

```
POST   /api/admin/quizzes
POST   /api/admin/quizzes/:quizId/questions
POST   /api/admin/quiz-sessions/:sessionCode/start
POST   /api/admin/quiz-sessions/:sessionCode/questions/:questionId/start
POST   /api/admin/quiz-sessions/:sessionCode/questions/:questionId/finish
GET    /api/admin/quiz-sessions/:sessionCode/current-question
GET    /api/admin/quiz-sessions/:sessionCode/results/current
GET    /api/admin/quiz-sessions/:sessionCode/results/final
POST   /api/admin/quiz-sessions/:sessionCode/close
```

### Public / team

```
GET    /api/session/:sessionCode/current-question
POST   /api/session/:sessionCode/questions/:questionId/answer    (Authorization: Bearer <team token>)
GET    /api/session/:sessionCode/results/current
GET    /api/session/:sessionCode/results/final
```

## Data model additions (`002_quiz_engine.sql`)

- `questions(id, quiz_id, order_index, prompt, points, created_at)` — `UNIQUE(quiz_id, order_index)`
- `answer_options(id, question_id, order_index, text, is_correct)` — `UNIQUE(question_id, order_index)`
- `answers(id, session_id, question_id, team_id, option_id, is_correct, points_awarded, submitted_at, finalized_at)` — `UNIQUE(session_id, question_id, team_id)` is the DB-level guarantee for one-answer-per-team-per-question
- `round_results(id, session_id, question_id, team_id, answered, is_correct, points_awarded, rank, cumulative_points, finalized_at)`
- `final_results(id, session_id, team_id, total_points, rank, finalized_at)`
- `quiz_sessions` adds: `answer_time_seconds`, `current_question_id`, `current_question_status`, `current_question_deadline`; `status` CHECK expanded
- `teams` adds: `token VARCHAR(64) UNIQUE`

Legacy v0.2.0 session statuses (`completed`, `cancelled`) remain valid in the CHECK constraint so old rows don't fail, but v3 code never writes them.

## State machines

### Session

```
pending  ── startSession ──▶ active
                              │
                       startQuestion
                              │
                              ▼
                       active (question live)
                              │
                       finishQuestion
                              │
            ┌─────────────────┴──────────────────┐
    (not last question)                   (last question)
            │                                    │
            ▼                                    ▼
      round_results ── startQuestion ─▶ … ── finished ── close ──▶ closed
                                                  │
                                                close
                                                  ▼
                                               closed
```

`close` is allowed from any state and is idempotent. It writes `final_results` if not yet present (so an admin can close early — the standings as-of-now get frozen).

### Per-current-question

```
   (NULL: no current question) ── startQuestion ──▶ live ── finishQuestion ──▶ closed
```

The current question and its state live on `quiz_sessions.current_question_id` and `quiz_sessions.current_question_status`. No other table tracks this — single source of truth. NULL means "no question is current" (e.g. session in `pending` or just-`closed` state).

## Project layout

```
bratislavabike-quiz-app/
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── app.js
│   ├── config.js
│   ├── db/
│   │   ├── pool.js
│   │   ├── migrate.js
│   │   └── migrations/
│   │       ├── 001_initial.sql
│   │       └── 002_quiz_engine.sql           (new)
│   ├── middleware/
│   │   ├── errors.js
│   │   └── requireAdmin.js
│   ├── routes/
│   │   ├── index.js                           (updated — mounts adminQuizzes)
│   │   ├── adminAuth.js
│   │   ├── adminQuizzes.js                    (new)
│   │   ├── adminSessions.js                   (rewritten)
│   │   └── publicSessions.js                  (rewritten)
│   ├── services/
│   │   ├── admins.js
│   │   ├── answers.js                         (new)
│   │   ├── questions.js                       (new)
│   │   ├── quizSessions.js                    (rewritten)
│   │   ├── quizzes.js                         (new)
│   │   └── teams.js                           (rewritten)
│   └── utils/
│       ├── httpError.js
│       ├── sessionCode.js
│       ├── statuses.js                        (new — state machine constants)
│       └── teamToken.js                       (new)
└── scripts/
    └── create-admin.js
```

## Environment variables

No new variables for v3. Same as v2.

| Name             | Required        | Notes                                          |
|------------------|-----------------|------------------------------------------------|
| `DATABASE_URL`   | yes (prod)      | From Railway Postgres plugin                   |
| `SESSION_SECRET` | yes (prod)      | `openssl rand -base64 48`                      |
| `NODE_ENV`       | no              | Railway sets to `production`                   |
| `PORT`           | no              | Railway injects                                |
| `COOKIE_NAME`    | no              | Defaults to `bbqa.sid`                         |

## Token storage note

Team tokens are 24 random bytes (`crypto.randomBytes(24)`) → 32-character base64url (~192 bits of entropy). Stored **plaintext** in `teams.token` with a `UNIQUE` constraint. Acceptable trade-off because:

- Sessions are short-lived (one tour group, one run).
- A leaked token can only submit one answer per question for a single live session — limited blast radius.
- Plaintext lookup is direct; no per-request hash comparison.

If later you want to switch to hashed tokens, it's a one-column migration plus changing `findByToken` to look up by a deterministic hash.

## End-to-end curl walkthrough

```bash
DOMAIN=https://app.bratislavabiketour.com

# Admin login
curl -s -c cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"username":"matus","password":"your-strong-password"}' \
  $DOMAIN/api/admin/login

# Create quiz
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Bratislava Old Town","description":"Demo"}' \
  $DOMAIN/api/admin/quizzes

# Add Q1 (assume returned quiz id=1, returned question id=1)
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{
    "prompt":"Which river runs through Bratislava?",
    "points":10,
    "options":[
      {"text":"Vltava","isCorrect":false},
      {"text":"Danube","isCorrect":true},
      {"text":"Hron","isCorrect":false}
    ]
  }' \
  $DOMAIN/api/admin/quizzes/1/questions

# Add Q2 (returned question id=2)
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{
    "prompt":"What year was Bratislava Castle first mentioned?",
    "points":20,
    "options":[
      {"text":"907 AD","isCorrect":true},
      {"text":"1241 AD","isCorrect":false}
    ]
  }' \
  $DOMAIN/api/admin/quizzes/1/questions

# Create session
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"quizId":1,"answerTimeSeconds":45}' \
  $DOMAIN/api/admin/quiz-sessions
# → { "session":{"sessionCode":"K7XQ24", ...}, ... }

# Teams join (save the returned token!)
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"teamName":"Wheelers"}' \
  $DOMAIN/api/session/K7XQ24/join
# → { "team":{...}, "sessionCode":"K7XQ24", "token":"<TOKEN_A>" }

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"teamName":"Pedals"}' \
  $DOMAIN/api/session/K7XQ24/join

# Admin starts session
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/start

# Admin starts Q1
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/questions/1/start

# Teams fetch question
curl -s $DOMAIN/api/session/K7XQ24/current-question

# Teams answer
curl -s -X POST -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN_A>' \
  -d '{"optionId":2}' \
  $DOMAIN/api/session/K7XQ24/questions/1/answer

# Admin finishes Q1
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/questions/1/finish

# Round results
curl -s $DOMAIN/api/session/K7XQ24/results/current

# Q2 + finish
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/questions/2/start
curl -s -X POST -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN_B>' \
  -d '{"optionId":4}' \
  $DOMAIN/api/session/K7XQ24/questions/2/answer
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/questions/2/finish
# → { "isLastQuestion":true, "sessionStatus":"finished" }

# Final standings
curl -s $DOMAIN/api/session/K7XQ24/results/final

# Close
curl -s -b cookies.txt -X POST $DOMAIN/api/admin/quiz-sessions/K7XQ24/close
```

## Review checklist — the 7 critical points

| # | Requirement | How it's enforced |
|---|---|---|
| 1 | One answer per team per question | `CONSTRAINT uq_answers_team_question UNIQUE (session_id, question_id, team_id)` on `answers`. App-level checks layer on top, but the DB is authoritative. |
| 2 | Cryptographically random team token | `crypto.randomBytes(24).toString('base64url')` in `src/utils/teamToken.js` — 192 bits of entropy. Stored plaintext in `teams.token` with `UNIQUE` constraint. Server-side validated in `answers.submit` by joining `teams.token` to `quiz_sessions.session_code`. |
| 3 | Single source of truth for current question | `quiz_sessions.current_question_id` is the only pointer. `current_question_status` and `current_question_deadline` are decomposed attributes of that single pointer, not separate sources. No other table tracks per-session question state. |
| 4 | `finishQuestion` is a single transaction | `src/services/quizSessions.js#finishQuestion` opens one client, `BEGIN`s, executes all eight steps (lock, validate, evaluate, award, rank, write round_results, conditionally write final_results, update status), then `COMMIT`s. `ROLLBACK` on any error. |
| 5 | Public never exposes `is_correct` | `getCurrentQuestion(_, { forAdmin: false })` selects `id, order_index, text` only — no `is_correct`. `publicSessions.js` always passes `forAdmin: false`. The correct option becomes visible only in `results/current` (after the question is over). |
| 6 | Closed session blocks everything | `teams.join` rejects on terminal status. `answers.submit` requires `current_question_status = 'live'`; `closeSession` sets it to NULL. `startQuestion` and `finishQuestion` both check `isTerminal(session.status)` first and bail out. |
| 7 | Strict server-side status transitions | All transitions guarded by `quiz_sessions.status` checks before any mutation. CHECK constraint on the DB column rejects bad values. Centralized constants in `src/utils/statuses.js`. Legacy v2 values (`completed`, `cancelled`) preserved only in the CHECK; treated as terminal by `isTerminal()` but never written. |

## WebSocket readiness

`server.js` builds the HTTP server explicitly (`http.createServer(app)`), so attaching `ws` or `socket.io` is one line. All state changes go through service methods completing single SQL transactions — a future WS layer can emit events after each service call returns successfully, and the data is consistent by then.

## What's out of scope for v3

- Frontend (admin UI, team UI)
- WebSockets
- Automated question timers (admin manually finishes)
- Multi-select questions
- Question editing / deletion endpoints
- Rate limiting
