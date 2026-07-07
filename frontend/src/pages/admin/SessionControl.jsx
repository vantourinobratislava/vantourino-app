import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { adminApi, ApiError } from '../../api/client.js';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useSound } from '../../hooks/useSound.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner, StatusBadge } from '../../components/ui.jsx';
import { LanguageSwitcher } from '../../components/LanguageSwitcher.jsx';
import { Podium } from '../../components/Podium.jsx';
import { ItemKindBadge } from '../../components/ItemKindBadge.jsx';
import { QRCodeImage } from '../../components/QRCodeImage.jsx';
import { useLang } from '../../i18n/lang.js';
import { useT, t } from '../../i18n/ui.js';

/*
 * Admin live-host control.
 *
 * A step-by-step moderator flow driven by session status:
 *   pending        → Start session (+ QR join panel)
 *   active, idle   → Start next question (sequential; no full picker)
 *   active, live   → Live question: prompt + options (correct highlighted),
 *                    countdown, live answer progress, who answered / pending,
 *                    current standings. Finish button.
 *   round_results  → Correct answer + explanation + team-by-team breakdown,
 *                    then "Next question" (or "Show final results" on the last).
 *   finished/closed→ Final standings.
 *
 * Polling: session detail every 4s; during a live question we also poll
 * live-status every 2s for the answer progress; round results every 4s.
 */

const POLL_SESSION_MS = 4000;
const POLL_LIVE_MS = 2000;
const POLL_RESULTS_MS = 4000;

const SESSION_FINISHED = new Set(['finished', 'closed', 'completed', 'cancelled']);

export default function SessionControl() {
  const { sessionCode } = useParams();
  const navigate = useNavigate();
  const [lang, setLang] = useLang();
  const tr = (key, vars) => t(lang, key, vars);

  const sessionPoll = usePolling(
    useCallback(() => adminApi.getSession(sessionCode, lang), [sessionCode, lang]),
    { intervalMs: POLL_SESSION_MS, deps: [sessionCode, lang] }
  );

  const session = sessionPoll.data && sessionPoll.data.session;
  const quiz = sessionPoll.data && sessionPoll.data.quiz;
  const teams = (sessionPoll.data && sessionPoll.data.teams) || [];
  const isOver = session ? SESSION_FINISHED.has(session.status) : false;

  // Issue 3: viewOnly = not the owner AND not super_admin.
  // Legacy sessions with createdBy === null are treated as no-owner; the
  // backend allows anyone with role/perm to control them, so the UI does
  // the same. Backend is the final authority — every action below
  // short-circuits client-side when viewOnly, and even if a button were
  // forced through, the backend's requireSessionOwnership returns 403.
  const { admin } = useAdminAuth();
  const isOwner = !!(session && admin && session.createdBy != null && Number(session.createdBy) === Number(admin.id));
  const isSuper = !!(admin && admin.role === 'super_admin');
  const isLegacyOpen = !!(session && session.createdBy == null);
  const viewOnly = !!session && !(isSuper || isOwner || isLegacyOpen);

  // B2.3: admin live language switcher for AUDIO playback. The chosen lang
  // is transient (no DB write), scoped per question id so switching items
  // clears any previous override. The poll re-fires with audioLang and the
  // backend resolves the right variant — UI lang stays untouched.
  const [audioLangByQ, setAudioLangByQ] = useState({});
  // After finishing an AUDIO item (which clears the session's current item on
  // the backend), remember which item was just finished so we can advance to
  // the next one even though session.currentQuestionId is now NULL. Cleared
  // when the session moves on (new current item, or session finishes).
  const [lastFinishedAudioQId, setLastFinishedAudioQId] = useState(null);

  // Authoritative read of the CURRENT item (kind, description, deadline). The
  // session payload reconstructs the item from the quiz list, which can lag or
  // miss `kind`; this dedicated read always reports the true kind, so we use it
  // as the source of truth for contest-vs-question routing and the timer.
  const currentQId = session && session.currentQuestionId;
  const audioLangForCurrent = currentQId ? (audioLangByQ[currentQId] || '') : '';
  const liveItemPoll = usePolling(
    useCallback(
      () => adminApi.getCurrentQuestion(sessionCode, lang, audioLangForCurrent || undefined),
      [sessionCode, lang, audioLangForCurrent]
    ),
    { intervalMs: POLL_SESSION_MS, deps: [sessionCode, lang, audioLangForCurrent] }
  );
  const liveItem = liveItemPoll.data && liveItemPoll.data.question;

  const startSessionAction = useAsyncAction(() => { if (viewOnly) return; return adminApi.startSession(sessionCode); });
  const closeSessionAction = useAsyncAction(() => { if (viewOnly) return; return adminApi.closeSession(sessionCode); });
  const startQuestionAction = useAsyncAction((qid) => { if (viewOnly) return; return adminApi.startQuestion(sessionCode, qid); });
  const finishQuestionAction = useAsyncAction((qid) => { if (viewOnly) return; return adminApi.finishQuestion(sessionCode, qid); });
  const pauseQuestionAction = useAsyncAction((qid) => { if (viewOnly) return; return adminApi.pauseQuestion(sessionCode, qid); });
  const resumeQuestionAction = useAsyncAction((qid) => { if (viewOnly) return; return adminApi.resumeQuestion(sessionCode, qid); });
  const awardAction = useAsyncAction((qid, awards) => { if (viewOnly) return; return adminApi.awardContest(sessionCode, qid, awards); });

  const sound = useSound();

  const actionError =
    startSessionAction.error || closeSessionAction.error ||
    startQuestionAction.error || finishQuestionAction.error ||
    pauseQuestionAction.error || resumeQuestionAction.error || sessionPoll.error;

  const questions = (quiz && quiz.questions) || [];

  // Ordered questions; figure out which is current and which comes next.
  const currentQuestion = useMemo(() => {
    if (!session || !session.currentQuestionId) return null;
    return questions.find((q) => q.id === session.currentQuestionId) || null;
  }, [session, questions]);

  // The "next question to start" = the first question whose order_index is
  // greater than the highest one we've already started/finished. We track the
  // furthest-progressed question by the current question's order index; if no
  // question has been started yet, next = first.
  //
  // AUDIO finishes clear current_question_id on the backend (no round-results
  // step). In that brief window — between the finish response and the next
  // session poll picking up the new current item — currentQuestion is null
  // and the naive logic would suggest "Start item 1" again. Falling back to
  // the just-finished audio qid keeps us on the correct next item.
  const nextQuestion = useMemo(() => {
    if (questions.length === 0) return null;
    const anchorId = (currentQuestion && currentQuestion.id) || lastFinishedAudioQId || null;
    if (!anchorId) return questions[0];
    const idx = questions.findIndex((q) => q.id === anchorId);
    return idx >= 0 && idx + 1 < questions.length ? questions[idx + 1] : null;
  }, [questions, currentQuestion, lastFinishedAudioQId]);

  // Once the session has moved past the just-finished audio (a new current
  // item was started, or the session is finished/closed), drop the anchor.
  useEffect(() => {
    if (!lastFinishedAudioQId) return;
    if (session && session.currentQuestionId && session.currentQuestionId !== lastFinishedAudioQId) {
      setLastFinishedAudioQId(null);
    } else if (session && (session.status === 'finished' || session.status === 'closed')) {
      setLastFinishedAudioQId(null);
    }
  }, [session, lastFinishedAudioQId]);

  const isLastQuestion = currentQuestion && !nextQuestion;

  // Robust contest detection for the CURRENT live item, from any authoritative
  // signal (so a single stale field can't misroute a contest as a timed
  // question):
  //  - the dedicated current-item read says kind === 'contest', OR
  //  - the session's quiz list says the current item is a contest, OR
  //  - the item is live with NO deadline (the backend only ever leaves the
  //    deadline NULL for contests; timed questions always have one).
  const liveItemIsCurrent = !!(liveItem && session && liveItem.id === session.currentQuestionId);
  // Audio first — it also has a NULL deadline, so it must be detected before the
  // contest fallback (which treats no-deadline live items as contests).
  const currentIsAudio = !!(
    (liveItemIsCurrent && liveItem.kind === 'audio') ||
    (currentQuestion && currentQuestion.kind === 'audio')
  );
  const currentIsContest = !currentIsAudio && !!(
    (liveItemIsCurrent && liveItem.kind === 'contest') ||
    (currentQuestion && currentQuestion.kind === 'contest') ||
    (session && session.currentQuestionStatus === 'live' && session.currentQuestionDeadline == null)
  );

  // ---- Handlers ----
  const onStartSession = async () => {
    const r = await startSessionAction.run();
    if (r.ok) sessionPoll.refetch();
  };
  const onCloseSession = async () => {
    if (!window.confirm(tr('sess_close_confirm'))) return;
    const r = await closeSessionAction.run();
    if (r.ok) sessionPoll.refetch();
  };
  const onStartQuestion = async (qid) => {
    sound.unlock(); // first gesture unlocks audio on mobile
    const r = await startQuestionAction.run(qid);
    if (r.ok) sessionPoll.refetch();
  };
  // A pause/resume/finish can lose a race to the server's timeout auto-finish
  // (the question closed a moment before the tap landed). That surfaces as a
  // 409 "not live / closed" — which is benign here: the server is already in
  // the right state, we just need to catch up. Detect it and refetch silently
  // rather than showing an alarming error.
  const isBenignRace = (err) =>
    err instanceof ApiError && err.status === 409 &&
    /not live|not paused|not the current question|closed|no answers accepted/i.test(err.message || '');

  const settle = (action) => {
    if (action.error && isBenignRace(action.error)) action.reset();
    sessionPoll.refetch();
  };

  const onFinishQuestion = async (qid) => {
    const r = await finishQuestionAction.run(qid);
    if (r.ok) {
      // AUDIO finishes clear current_question_id on the backend (no round-
      // results step). Capture the qid so nextQuestion can advance from it
      // even before the poll refreshes. Non-audio paths leave current set, so
      // the existing currentQuestion logic continues to drive routing.
      if (r.value && r.value.audio && !r.value.isLastQuestion) {
        setLastFinishedAudioQId(qid);
      }
      sessionPoll.refetch();
    } else {
      settle(finishQuestionAction);
    }
  };
  const onPauseQuestion = async (qid) => {
    const r = await pauseQuestionAction.run(qid);
    if (r.ok) sessionPoll.refetch();
    else settle(pauseQuestionAction);
  };
  const onResumeQuestion = async (qid) => {
    const r = await resumeQuestionAction.run(qid);
    if (r.ok) sessionPoll.refetch();
    else settle(resumeQuestionAction);
  };

  // ---- Sound cues on state transitions ----
  // We watch the polled question status and fire a cue when it changes.
  const prevStatusRef = useRef(null);
  const warnedRef = useRef(false);
  const qStatus = session ? session.currentQuestionStatus : null;
  const qId = session ? session.currentQuestionId : null;
  const prevQIdRef = useRef(qId);

  useEffect(() => {
    const prev = prevStatusRef.current;
    // New question went live (or resumed into live from a different state).
    if (qStatus === 'live' && prev !== 'live') {
      if (prevQIdRef.current !== qId || prev === null) warnedRef.current = false;
      sound.play('start');
    }
    // Question just finished → results revealed.
    if (qStatus !== 'live' && qStatus !== 'paused' && (prev === 'live' || prev === 'paused')) {
      // 'closed'/round_results → time up + reveal.
      sound.play('reveal');
    }
    // Whenever the question status or id changes, clear any one-shot action
    // errors so a transient race-error (e.g. a pause that lost to auto-finish)
    // can never linger on screen into the next question.
    if (qStatus !== prev || qId !== prevQIdRef.current) {
      pauseQuestionAction.reset();
      resumeQuestionAction.reset();
      finishQuestionAction.reset();
      startQuestionAction.reset();
    }
    prevStatusRef.current = qStatus;
    prevQIdRef.current = qId;
  }, [qStatus, qId, sound, pauseQuestionAction, resumeQuestionAction, finishQuestionAction, startQuestionAction]);

  // ---- Loading / error gates ----
  if (sessionPoll.loading) {
    return (
      <div className="page">
        <AppBar title={tr('sess_title_short')} back backTo="/admin" />
        <main className="page__main"><Spinner label={tr('sess_loading')} /></main>
      </div>
    );
  }
  if (sessionPoll.error && !session) {
    return (
      <div className="page">
        <AppBar title={tr('sess_title_short')} back backTo="/admin" />
        <main className="page__main">
          <Alert kind="error">
            {sessionPoll.error instanceof ApiError && sessionPoll.error.status === 404
              ? tr('sess_not_found') : sessionPoll.error.message}
          </Alert>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Link to="/admin" className="btn btn--secondary">{tr('sess_back_dashboard')}</Link>
          </div>
        </main>
      </div>
    );
  }
  if (!session) return null;

  const status = session.status;
  const questionLive = status === 'active' && session.currentQuestionStatus === 'live';
  const questionPaused = status === 'active' && session.currentQuestionStatus === 'paused';
  const questionActive = questionLive || questionPaused;
  const showResults = status === 'round_results';

  return (
    <div className="page">
      <AppBar
        title={tr('sess_title')}
        back
        backTo="/admin"
        right={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className={`btn btn--ghost btn--small${sound.enabled ? ' is-on' : ''}`}
              onClick={sound.toggle}
              aria-pressed={sound.enabled}
              title={sound.enabled ? tr('sess_sound_on') : tr('sess_sound_off')}
            >
              {sound.enabled ? '🔊' : '🔇'}
            </button>
            <LanguageSwitcher lang={lang} onChange={setLang} available={quiz && quiz.languages} light compact />
          </span>
        }
      />
      <main className="page__main page__main--wide">
        <div className="stack-lg">
          {/* Issue 3: explain why action buttons are inert when the user
              isn't the session owner or super_admin. Backend also returns
              403 on any control attempt — this is the friendly UX cue. */}
          {viewOnly ? (
            <Alert kind="info">
              {tr('sessions_view_only_banner', {
                name: (session && session.createdByUsername) || '—',
              })}
            </Alert>
          ) : null}
          {/* Header */}
          <div className="row row--between" style={{ alignItems: 'flex-start' }}>
            <div>
              <p className="muted small">{tr('sess_code')}</p>
              <p className="mono bold" style={{ fontSize: '1.5rem', letterSpacing: '0.15em' }}>
                {session.sessionCode}
              </p>
              {quiz ? <p className="muted small" style={{ marginTop: 'var(--space-2)' }}>{quiz.title}</p> : null}
            </div>
            <StatusBadge status={status} />
          </div>

          {actionError ? <Alert kind="error">{actionError.message}</Alert> : null}

          {/* Step: PENDING → join + start */}
          {status === 'pending' ? (
            <>
              <JoinPanel sessionCode={session.sessionCode} />
              <section className="card stack">
                <h2>{tr('sess_ready_to_start')}</h2>
                <p className="muted small">
                  {teams.length === 0
                    ? tr('sess_waiting_teams')
                    : tr(teams.length === 1 ? 'sess_teams_joined' : 'sess_teams_joined_plural', { n: teams.length })}
                </p>
                {questions.length === 0 ? (
                  <Alert kind="warn">{tr('sess_no_questions')}</Alert>
                ) : null}
                <button
                  className="btn btn--accent"
                  onClick={onStartSession}
                  disabled={startSessionAction.busy || questions.length === 0}
                >
                  {startSessionAction.busy ? tr('sess_starting') : tr('sess_start_session')}
                </button>
              </section>
              <TeamsCard teams={teams} />
            </>
          ) : null}

          {/* Step: ACTIVE + LIVE/PAUSED item → host live view (audio / contest / question) */}
          {questionActive && currentQuestion ? (
            currentIsAudio ? (
              <AudioPanel
                lang={lang}
                question={liveItemIsCurrent ? { ...currentQuestion, ...liveItem } : currentQuestion}
                isLast={isLastQuestion}
                onFinish={() => onFinishQuestion(currentQuestion.id)}
                finishBusy={finishQuestionAction.busy}
                audioLang={audioLangForCurrent}
                onAudioLangChange={(l) => setAudioLangByQ((m) => ({ ...m, [currentQuestion.id]: l || '' }))}
              />
            ) : currentIsContest ? (
              <ContestPanel
                sessionCode={sessionCode}
                lang={lang}
                question={liveItemIsCurrent ? { ...currentQuestion, ...liveItem } : currentQuestion}
                teams={teams}
                onAward={(awards) => awardAction.run(currentQuestion.id, awards)}
                awardBusy={awardAction.busy}
                awardError={awardAction.error}
                onFinish={() => onFinishQuestion(currentQuestion.id)}
                finishBusy={finishQuestionAction.busy}
              />
            ) : (
              <LiveQuestionPanel
                sessionCode={sessionCode}
                lang={lang}
                question={currentQuestion}
                deadline={session.currentQuestionDeadline}
                paused={questionPaused}
                remainingMs={session.remainingMs}
                onFinish={() => onFinishQuestion(currentQuestion.id)}
                finishBusy={finishQuestionAction.busy}
                onPause={() => onPauseQuestion(currentQuestion.id)}
                onResume={() => onResumeQuestion(currentQuestion.id)}
                pauseBusy={pauseQuestionAction.busy}
                resumeBusy={resumeQuestionAction.busy}
                sound={sound}
                onTimeUp={() => sessionPoll.refetch()}
              />
            )
          ) : null}

          {/* Step: ACTIVE + idle (between items) → start next */}
          {status === 'active' && !questionActive ? (
            <section className="card stack">
              <h2>{currentQuestion ? tr('sess_next_item') : tr('sess_first_item')}</h2>
              {nextQuestion ? (
                <>
                  <p className="muted small">
                    {tr(nextQuestion.kind === 'contest' ? 'sess_contest_of' : nextQuestion.kind === 'audio' ? 'sess_audio_of' : 'sess_question_of', { n: nextQuestion.orderIndex, total: questions.length })}
                  </p>
                  <p className="bold">
                    {nextQuestion.kind && nextQuestion.kind !== 'question' ? <ItemKindBadge kind={nextQuestion.kind} /> : null}
                    {nextQuestion.prompt}
                  </p>
                  <button
                    className="btn btn--accent"
                    onClick={() => onStartQuestion(nextQuestion.id)}
                    disabled={startQuestionAction.busy}
                  >
                    {startQuestionAction.busy
                      ? tr('sess_starting')
                      : tr(nextQuestion.kind === 'contest' ? 'sess_start_contest_n' : nextQuestion.kind === 'audio' ? 'sess_start_audio_n' : 'sess_start_question_n', { n: nextQuestion.orderIndex })}
                  </button>
                </>
              ) : (
                <p className="muted small">{tr('sess_all_played')}</p>
              )}
            </section>
          ) : null}

          {/* Step: ROUND RESULTS → correct answer + explanation + breakdown */}
          {showResults ? (
            <RoundResultsPanel
              sessionCode={sessionCode}
              lang={lang}
              nextQuestion={nextQuestion}
              isLastQuestion={isLastQuestion}
              onStartNext={() => nextQuestion && onStartQuestion(nextQuestion.id)}
              startBusy={startQuestionAction.busy}
              onClose={onCloseSession}
              closeBusy={closeSessionAction.busy}
            />
          ) : null}

          {/* Step: FINISHED / CLOSED → final */}
          {isOver ? (
            <>
              <FinalResults sessionCode={sessionCode} />
              <div className="btn-row">
                <Link to="/admin" className="btn btn--secondary" style={{ display: 'inline-flex' }}>
                  {tr('sess_back_dashboard')}
                </Link>
              </div>
            </>
          ) : null}

          {/* Persistent footer controls while session is running */}
          {!isOver && status !== 'pending' ? (
            <div className="btn-row">
              <button className="btn btn--danger" onClick={onCloseSession} disabled={closeSessionAction.busy}>
                {closeSessionAction.busy ? tr('sess_closing') : tr('sess_close_session')}
              </button>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/* ----------------- Live question panel ----------------- */

function LiveQuestionPanel({
  sessionCode, lang, question, deadline, paused, remainingMs,
  onFinish, finishBusy, onPause, onResume, pauseBusy, resumeBusy, sound, onTimeUp,
}) {
  const tr = (key, vars) => t(lang, key, vars);
  // When paused there's no running deadline; show the frozen remaining seconds.
  const liveSeconds = useCountdown(paused ? null : deadline);
  const frozenSeconds = remainingMs != null ? Math.ceil(remainingMs / 1000) : null;
  const seconds = paused ? frozenSeconds : liveSeconds;

  // Fire the "last 10 seconds" warning once per live run.
  const warnedRef = useRef(false);
  useEffect(() => {
    if (paused) return; // don't warn while paused
    if (liveSeconds != null && liveSeconds <= 10 && liveSeconds > 0 && !warnedRef.current) {
      warnedRef.current = true;
      if (sound) sound.play('warning');
    }
    if (liveSeconds != null && liveSeconds > 10) warnedRef.current = false; // re-arm (e.g. after resume)
  }, [liveSeconds, paused, sound]);

  // Time-up: when the live countdown hits 0, play the cue and ask the parent to
  // refetch — that triggers the server's auto-finish so the admin transitions
  // into results promptly (in sync with teams), instead of waiting for the next
  // scheduled session poll and leaving a stale "live" timer on screen.
  const hitZeroRef = useRef(false);
  useEffect(() => {
    if (paused) return;
    if (liveSeconds === 0 && !hitZeroRef.current) {
      hitZeroRef.current = true;
      if (sound) sound.play('timeup');
      if (onTimeUp) onTimeUp();
    }
    if (liveSeconds != null && liveSeconds > 0) hitZeroRef.current = false;
  }, [liveSeconds, paused, sound, onTimeUp]);

  // Live answer status (who answered / pending) — fast poll.
  const live = usePolling(
    useCallback(() => adminApi.getLiveStatus(sessionCode), [sessionCode]),
    { intervalMs: POLL_LIVE_MS, deps: [sessionCode] }
  );
  const counts = (live.data && live.data.counts) || { total: 0, answered: 0, pending: 0 };
  const liveTeams = (live.data && live.data.teams) || [];

  return (
    <section className="card stack">
      <div className="row row--between">
        <span className={`badge ${paused ? 'badge--paused' : 'badge--live'}`}>
          {paused ? tr('sess_paused') : tr('sess_live')}
        </span>
        {seconds !== null ? (
          <span className={`deadline__num ${!paused && seconds <= 5 ? 'deadline__num--low' : ''}${paused ? ' deadline__num--paused' : ''}`}>
            {seconds}s
          </span>
        ) : null}
      </div>

      {paused ? (
        <div className="paused-banner">{tr('sess_paused_banner')}</div>
      ) : null}

      <div>
        <p className="muted small">{tr('team_question_n', { n: question.orderIndex })} · {question.points} {tr('common_pts')}</p>
        <p className="q-prompt" style={{ fontSize: '1.25rem' }}>{question.prompt}</p>
      </div>

      {/* Options — during the LIVE/PAUSED phase the correct answer is
          intentionally NOT revealed (the admin screen may be visible to
          players/bystanders). The correct option is highlighted only after
          finishing, in the round-results view. */}
      <div className="q-options">
        {(question.options || []).map((opt) => (
          <div key={opt.id} className="q-option" style={{ cursor: 'default' }}>
            {opt.text}
          </div>
        ))}
      </div>

      {/* Live answer progress */}
      <div className="stack-tight">
        <div className="row row--between">
          <span className="bold">{tr('sess_answered_of', { answered: counts.answered, total: counts.total })}</span>
          {counts.pending > 0 ? <span className="tiny muted">{tr('sess_pending', { n: counts.pending })}</span> : null}
        </div>
        <div className="progress">
          <div
            className="progress__bar"
            style={{ width: `${counts.total ? Math.round((counts.answered / counts.total) * 100) : 0}%` }}
          />
        </div>
      </div>

      {/* Per-team answered / waiting */}
      {liveTeams.length > 0 ? (
        <ul className="standings">
          {liveTeams.map((lt) => (
            <li key={lt.teamId} className={`standing-row ${lt.answered ? 'standing-row--correct' : ''}`}
                style={{ gridTemplateColumns: '1fr auto' }}>
              <span className="standing-row__name">{lt.teamName}</span>
              <span className="tiny" style={{ color: lt.answered ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                {lt.answered ? `✓ ${formatTime(lt.answeredAt)}` : tr('sess_waiting')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{tr('sess_no_teams_joined')}</p>
      )}

      <div className="btn-row">
        {paused ? (
          <button className="btn btn--accent" onClick={onResume} disabled={resumeBusy}>
            {resumeBusy ? tr('sess_resuming') : tr('sess_resume')}
          </button>
        ) : (
          <button className="btn btn--secondary" onClick={onPause} disabled={pauseBusy}>
            {pauseBusy ? tr('sess_pausing') : tr('sess_pause')}
          </button>
        )}
        <button className="btn btn--accent" onClick={onFinish} disabled={finishBusy}>
          {finishBusy ? tr('sess_finishing') : tr('sess_finish_question')}
        </button>
      </div>
    </section>
  );
}

/* ----------------- Contest panel (admin manual scoring) ----------------- */

function AudioPanel({ lang, question, isLast, onFinish, finishBusy, audioLang, onAudioLangChange }) {
  const tr = (key, vars) => t(lang, key, vars);
  const title = question.prompt;
  const description = question.description || tr('audio_default_desc');
  const url = question.audioUrl || '';

  // Variant chip rendering only when the linked guide actually has variants.
  // For raw-URL items the backend returns audioAvailableLangs=null and we
  // hide the switcher entirely.
  const availableLangs = Array.isArray(question.audioAvailableLangs) ? question.audioAvailableLangs : null;
  const source = question.audioSource || null;
  const usedLang = source && source.usedLang ? source.usedLang : null;
  const fellBack = !!(source && source.fellBack);
  // variantId keys the <audio> so the element is recreated when the variant
  // changes — avoids a stale buffered stream when the admin flips language.
  const audioKey = (source && source.variantId) ? `v${source.variantId}` : `url:${url}`;

  return (
    <section className="card stack">
      <div className="row row--between">
        <span className="badge badge--live">{tr('sess_audio')}</span>
      </div>

      <div>
        <p className="muted small">{tr('team_audio_n', { n: question.orderIndex })}</p>
        <p className="q-prompt" style={{ fontSize: '1.25rem' }}>{title}</p>
        {description ? <p className="muted">{description}</p> : null}
      </div>

      {availableLangs && availableLangs.length > 0 ? (
        <div className="audio-lang-switcher">
          <span className="audio-lang-switcher__label">{tr('audio_switcher_label')}</span>
          <div className="audio-lang-switcher__chips" role="group" aria-label={tr('audio_switcher_label')}>
            <button
              type="button"
              className={`lang-chip${!audioLang ? ' lang-chip--active' : ''}`}
              aria-pressed={!audioLang}
              onClick={() => onAudioLangChange && onAudioLangChange('')}
              title={tr('audio_switcher_auto_hint')}
            >
              {tr('audio_switcher_auto')}
            </button>
            {availableLangs.map((l) => (
              <button
                key={l}
                type="button"
                className={`lang-chip${audioLang === l ? ' lang-chip--active' : ''}${usedLang === l ? ' lang-chip--playing' : ''}`}
                aria-pressed={audioLang === l}
                onClick={() => onAudioLangChange && onAudioLangChange(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          {usedLang ? (
            <p className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>
              {fellBack
                ? tr('audio_switcher_fellback', { picked: (audioLang || lang || '').toUpperCase(), used: usedLang.toUpperCase() })
                : tr('audio_switcher_playing', { used: usedLang.toUpperCase() })}
            </p>
          ) : null}
        </div>
      ) : null}

      {url ? (
        <audio key={audioKey} controls preload="metadata" src={url} style={{ width: '100%' }}>
          {tr('audio_unsupported')}
        </audio>
      ) : (
        <Alert kind="warn">{tr('audio_no_url')}</Alert>
      )}

      <div className="btn-row">
        <button className="btn btn--accent" onClick={onFinish} disabled={finishBusy}>
          {finishBusy ? tr('sess_finishing') : (isLast ? tr('sess_finish_show_final') : tr('sess_next_challenge'))}
        </button>
      </div>
    </section>
  );
}

function ContestPanel({ sessionCode, lang, question, teams, onAward, awardBusy, awardError, onFinish, finishBusy }) {
  const tr = (key, vars) => t(lang, key, vars);
  // Pull title + description (language-resolved) from the live read.
  const cq = usePolling(
    useCallback(() => adminApi.getCurrentQuestion(sessionCode, lang), [sessionCode, lang]),
    { intervalMs: POLL_SESSION_MS, deps: [sessionCode, lang] }
  );
  const detail = cq.data && cq.data.question;
  const maxPoints = (detail && detail.points) != null ? detail.points : question.points;
  const title = (detail && detail.prompt) || question.prompt;
  const description = detail && detail.description;

  // Local per-team award state (string inputs), keyed by team id.
  const [awards, setAwards] = useState({});
  const [localError, setLocalError] = useState(null);
  const [savedNote, setSavedNote] = useState(false);

  // Initialize blank awards as teams arrive.
  useEffect(() => {
    setAwards((prev) => {
      const next = { ...prev };
      for (const t of teams) if (next[t.id] === undefined) next[t.id] = '0';
      return next;
    });
  }, [teams]);

  const setAward = (teamId, value) => {
    setSavedNote(false);
    setAwards((m) => ({ ...m, [teamId]: value }));
  };

  const validate = () => {
    const out = [];
    for (const t of teams) {
      const raw = awards[t.id];
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0 || n > maxPoints) {
        return { error: tr('sess_award_range_err', { team: t.name, max: maxPoints }) };
      }
      out.push({ teamId: t.id, points: n });
    }
    return { awards: out };
  };

  const onSave = async () => {
    setLocalError(null);
    setSavedNote(false);
    const v = validate();
    if (v.error) { setLocalError(v.error); return; }
    const r = await onAward(v.awards);
    if (r && r.ok) setSavedNote(true);
  };

  const onFinishClick = async () => {
    setLocalError(null);
    const v = validate();
    if (v.error) { setLocalError(v.error); return; }
    // Save the latest awards first, then finish (ignore a benign save race).
    const r = await onAward(v.awards);
    if (r && !r.ok) return; // surfaced via awardError
    onFinish();
  };

  const errorMessage = localError || (awardError && awardError.message);

  return (
    <section className="card stack">
      <div className="row row--between">
        <span className="badge badge--live">{tr('sess_contest')}</span>
        <span className="tiny muted">{tr('sess_max_pts', { max: maxPoints })}</span>
      </div>

      <div>
        <p className="muted small">{tr('team_contest_n', { n: question.orderIndex })}</p>
        <p className="q-prompt" style={{ fontSize: '1.25rem' }}>{title}</p>
        {description ? <p className="muted">{description}</p> : null}
      </div>

      {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}
      {savedNote ? <Alert kind="success">{tr('sess_awards_saved')}</Alert> : null}

      <div className="stack-tight">
        <span className="field__label">{tr('sess_award_points', { max: maxPoints })}</span>
        {teams.length === 0 ? (
          <p className="muted small">{tr('sess_no_teams_yet')}</p>
        ) : (
          <ul className="standings">
            {teams.map((t) => (
              <li key={t.id} className="award-row">
                <span className="award-row__name">{t.name}</span>
                <input
                  className="input award-row__input"
                  type="number"
                  min={0}
                  max={maxPoints}
                  inputMode="numeric"
                  value={awards[t.id] ?? '0'}
                  onChange={(e) => setAward(t.id, e.target.value)}
                  aria-label={`Points for ${t.name}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="btn-row">
        <button className="btn btn--secondary" onClick={onSave} disabled={awardBusy || teams.length === 0}>
          {awardBusy ? tr('common_saving') : tr('sess_save_awards')}
        </button>
        <button className="btn btn--accent" onClick={onFinishClick} disabled={finishBusy || awardBusy}>
          {finishBusy ? tr('sess_finishing') : tr('sess_finish_contest')}
        </button>
      </div>
    </section>
  );
}

/* ----------------- Round results panel ----------------- */

function RoundResultsPanel({ sessionCode, lang, nextQuestion, isLastQuestion, onStartNext, startBusy, onClose, closeBusy }) {
  const tr = (key, vars) => t(lang, key, vars);
  const { data, loading, error, refetch } = usePolling(
    useCallback(() => adminApi.getCurrentResults(sessionCode, lang), [sessionCode, lang]),
    { intervalMs: POLL_RESULTS_MS, deps: [sessionCode, lang] }
  );

  if (loading) return <section className="card"><Spinner label={tr('sess_loading_results')} /></section>;
  if (error) return <Alert kind="error">{error.message}</Alert>;
  if (!data || !data.question) return <section className="card"><p className="muted small">{tr('sess_no_standings')}</p></section>;

  const isContest =
    data.question.kind === 'contest' ||
    (!data.correctOption && data.results && data.results.every((r) => !r.selectedOption));

  return (
    <>
      <section className="card stack">
        <div className="row row--between">
          <h2 style={{ fontSize: '1.0625rem' }}>
            {tr(isContest ? 'sess_contest_results' : 'sess_round_results', { n: data.question.orderIndex })}
          </h2>
        </div>
        <p className="bold">
          {isContest ? <ItemKindBadge kind="contest" /> : null}
          {data.question.prompt}
        </p>

        {/* Correct answer — questions only */}
        {!isContest && data.correctOption ? (
          <div className="q-option q-option--correct" style={{ cursor: 'default' }}>
            <span>✓ {data.correctOption.text}</span>
          </div>
        ) : null}

        {/* Explanation (question) or description (contest) */}
        {data.question.explanation ? (
          <div className="explanation">
            <span className="explanation__label">{isContest ? tr('sess_description_label') : tr('sess_correct_label')}</span>
            <p>{data.question.explanation}</p>
          </div>
        ) : null}
      </section>

      {/* Team-by-team breakdown */}
      <section className="stack-tight">
        <h3 style={{ fontSize: '1rem' }}>{isContest ? tr('sess_awarded_points') : tr('sess_team_breakdown')}</h3>
        <ul className="standings">
          {data.results.map((r) => (
            isContest ? (
              <li key={r.teamId} className="standing-row standing-row--block">
                <div className="row row--between" style={{ width: '100%' }}>
                  <span className="standing-row__rank">#{r.rank}</span>
                  <span className="standing-row__name" style={{ flex: 1, marginLeft: 'var(--space-2)' }}>{r.teamName}</span>
                  <span className="standing-row__points">{r.cumulativePoints}</span>
                </div>
                <div className="row row--between breakdown-detail" style={{ width: '100%' }}>
                  <span className="tiny muted">{tr('sess_awarded_this_contest')}</span>
                  <span className="tiny tag-correct">+{r.pointsAwarded}</span>
                </div>
              </li>
            ) : (
              <li
                key={r.teamId}
                className={`standing-row standing-row--block ${r.answered ? (r.isCorrect ? 'standing-row--correct' : 'standing-row--wrong') : ''}`}
              >
                <div className="row row--between" style={{ width: '100%' }}>
                  <span className="standing-row__rank">#{r.rank}</span>
                  <span className="standing-row__name" style={{ flex: 1, marginLeft: 'var(--space-2)' }}>{r.teamName}</span>
                  <span className="standing-row__points">{r.cumulativePoints}</span>
                </div>
                <div className="row row--between breakdown-detail" style={{ width: '100%' }}>
                  <span className="tiny muted">
                    {r.answered
                      ? <>{tr('sess_picked')}: <strong>{r.selectedOption ? r.selectedOption.text : tr('sess_picked_none')}</strong></>
                      : tr('sess_no_answer')}
                  </span>
                  <span className={`tiny ${r.isCorrect ? 'tag-correct' : (r.answered ? 'tag-wrong' : 'muted')}`}>
                    {r.answered ? (r.isCorrect ? `✓ +${r.pointsAwarded}` : '✗ +0') : '+0'}
                  </span>
                </div>
              </li>
            )
          ))}
        </ul>
        <button className="btn btn--ghost btn--small" onClick={refetch}>{tr('common_refresh')}</button>
      </section>

      {/* Advance */}
      <section className="card stack">
        {nextQuestion ? (
          <>
            <p className="muted small">{tr(nextQuestion.kind === 'contest' ? 'sess_up_next_c' : 'sess_up_next_q', { n: nextQuestion.orderIndex })}</p>
            <button className="btn btn--accent" onClick={onStartNext} disabled={startBusy}>
              {startBusy ? tr('sess_starting') : tr(nextQuestion.kind === 'contest' ? 'sess_next_contest' : 'sess_next_question')}
            </button>
          </>
        ) : (
          <>
            <p className="muted small">{tr('sess_last_item')}</p>
            <button className="btn btn--accent" onClick={onClose} disabled={closeBusy}>
              {closeBusy ? tr('sess_finishing') : tr('sess_finish_show_final')}
            </button>
          </>
        )}
      </section>
    </>
  );
}

/* ----------------- Final results ----------------- */

function FinalResults({ sessionCode }) {
  const { t: tr } = useT();
  const { data, loading, error, refetch } = usePolling(
    useCallback(() => adminApi.getFinalResults(sessionCode), [sessionCode]),
    { intervalMs: 10000, deps: [sessionCode] }
  );

  if (loading) return <section className="card"><Spinner label={tr('sess_loading_standings')} /></section>;
  if (error) {
    if (error instanceof ApiError && error.status === 409) {
      return <section className="card"><p className="muted small">{tr('sess_final_appear')}</p></section>;
    }
    return <Alert kind="error">{error.message}</Alert>;
  }
  if (!data || !data.results || data.results.length === 0) {
    return <section className="card"><p className="muted small">{tr('sess_no_standings')}</p></section>;
  }

  return (
    <section className="stack">
      <div className="hero hero--win">
        <p className="hero__label">{tr('sess_final_results')}</p>
        <h2 style={{ margin: 0 }}>{data.results[0] ? tr('sess_wins', { team: data.results[0].teamName }) : tr('team_final_standings')}</h2>
      </div>

      <Podium results={data.results} />

      <h3 style={{ fontSize: '1rem' }}>{tr('sess_full_standings')}</h3>
      <ul className="standings">
        {data.results.map((r) => (
          <li key={r.teamId} className={`standing-row${r.rank <= 3 ? ' standing-row--top' : ''}`}>
            <span className="standing-row__rank">#{r.rank}</span>
            <span className="standing-row__name">{r.teamName}</span>
            <span />
            <span className="standing-row__points">{r.totalPoints}</span>
          </li>
        ))}
      </ul>
      <button className="btn btn--ghost btn--small" onClick={refetch}>{tr('common_refresh')}</button>
    </section>
  );
}

/* ----------------- Shared bits ----------------- */

function TeamsCard({ teams }) {
  const { t: tr } = useT();
  return (
    <section className="stack-tight">
      <h2 style={{ fontSize: '1rem' }}>{tr('sess_teams_count', { n: teams.length })}</h2>
      {teams.length === 0 ? (
        <p className="muted small">{tr('sess_no_teams')}</p>
      ) : (
        <ul className="standings">
          {teams.map((t) => (
            <li key={t.id} className="standing-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span className="standing-row__name">{t.name}</span>
              <span className="tiny muted">{formatTime(t.joinedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JoinPanel({ sessionCode }) {
  const { t: tr } = useT();
  const joinUrl = `${window.location.origin}/join/${encodeURIComponent(sessionCode)}`;
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this join link:', joinUrl);
    }
  };

  return (
    <section className="card">
      <div className="qr-panel">
        <h2 style={{ fontSize: '1rem' }}>{tr('sess_join_heading')}</h2>
        <div className="qr-frame">
          <QRCodeImage value={joinUrl} size={200} />
        </div>
        <div className="join-url">{joinUrl}</div>
        <button className="btn btn--secondary btn--small" onClick={onCopy}>
          {copied ? tr('sess_copied') : tr('sess_copy_link')}
        </button>
      </div>
    </section>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}
