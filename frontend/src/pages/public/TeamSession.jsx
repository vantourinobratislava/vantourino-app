import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { publicApi, ApiError } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { loadTeamSession, clearTeamSession } from '../../auth/teamStorage.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner, StaleHint } from '../../components/ui.jsx';
import { LanguageSwitcher } from '../../components/LanguageSwitcher.jsx';
import { Podium } from '../../components/Podium.jsx';
import { ItemKindBadge } from '../../components/ItemKindBadge.jsx';
import { useLang } from '../../i18n/lang.js';
import { useT, t } from '../../i18n/ui.js';

const POLL_LOBBY_MS = 3000;
const POLL_LIVE_MS = 2000;
const POLL_RESULTS_MS = 4000;

const SESSION_FINISHED = new Set(['finished', 'closed', 'completed', 'cancelled']);

export default function TeamSession() {
  const { sessionCode } = useParams();
  const navigate = useNavigate();
  const [lang, setLang] = useLang();

  // Pull team identity from storage. If absent, send them to /join.
  const [team] = useState(() => loadTeamSession(sessionCode));

  // We adapt polling speed to what's happening. Tracked separately so we
  // can switch tempo as state changes.
  const [pollMs, setPollMs] = useState(POLL_LOBBY_MS);

  const fetcher = useCallback(() => publicApi.getCurrentQuestion(sessionCode, lang), [sessionCode, lang]);
  const cq = usePolling(fetcher, { intervalMs: pollMs, deps: [sessionCode, lang] });

  // Track which questions we've already answered (in this browser).
  const [answered, setAnswered] = useState(() => ({})); // { [questionId]: { optionId, accepted } }

  // Adapt poll cadence to the visible state.
  useEffect(() => {
    if (!cq.data) return;
    const s = cq.data.sessionStatus;
    if (SESSION_FINISHED.has(s)) {
      setPollMs(15000); // session over — slow poll, mostly so manual refresh still works
    } else if (cq.data.question && (cq.data.question.status === 'live' || cq.data.question.status === 'paused')) {
      setPollMs(POLL_LIVE_MS);
    } else {
      setPollMs(POLL_LOBBY_MS);
    }
  }, [cq.data]);

  if (!team) {
    return <Navigate to={`/join/${encodeURIComponent(sessionCode)}`} replace />;
  }

  // ----- Render trunk -----
  const availableLangs = cq.data && cq.data.question && cq.data.question.languages;

  if (cq.loading) {
    return (
      <div className="page">
        <AppBar title={sessionCode} right={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} light compact />
            <TeamPill name={team.teamName} />
          </span>
        } />
        <main className="page__main"><Spinner label="Connecting…" /></main>
      </div>
    );
  }

  if (cq.error && !cq.data) {
    return (
      <div className="page">
        <AppBar title={sessionCode} right={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} light compact />
            <TeamPill name={team.teamName} />
          </span>
        } />
        <main className="page__main">
          <Alert kind="error">
            {cq.error instanceof ApiError && cq.error.status === 404
              ? 'Session not found.'
              : cq.error.message}
          </Alert>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <button
              className="btn btn--secondary"
              onClick={() => { clearTeamSession(sessionCode); navigate('/', { replace: true }); }}
            >
              Leave session
            </button>
          </div>
        </main>
      </div>
    );
  }

  const sessionStatus = cq.data.sessionStatus;
  const question = cq.data.question;

  if (SESSION_FINISHED.has(sessionStatus)) {
    return (
      <PageShell team={team} sessionCode={sessionCode} stale={cq.stale} lang={lang} setLang={setLang}>
        <FinalView sessionCode={sessionCode} team={team} sessionStatus={sessionStatus} />
      </PageShell>
    );
  }

  // Item is live or paused → show it. Contests show an in-progress state with
  // no options/submit/timer; questions show the answer form as before. We treat
  // it as a contest if kind says so, OR (robustness) if it's live with no
  // deadline and no options — the backend only does that for contests.
  if (question && (question.status === 'live' || question.status === 'paused')) {
    const isAudio = question.kind === 'audio';
    const isContest = !isAudio && (
      question.kind === 'contest' ||
      ((question.deadline == null) && (!question.options || question.options.length === 0))
    );
    return (
      <PageShell team={team} sessionCode={sessionCode} stale={cq.stale} lang={lang} setLang={setLang}>
        {isAudio ? (
          <AudioView question={question} />
        ) : isContest ? (
          <ContestView question={question} />
        ) : (
          <QuestionView
            sessionCode={sessionCode}
            question={question}
            paused={question.status === 'paused'}
            team={team}
            answeredEntry={answered[question.id]}
            onAnswered={(optionId, accepted) =>
              setAnswered((a) => ({ ...a, [question.id]: { optionId, accepted } }))
            }
          />
        )}
      </PageShell>
    );
  }

  // Otherwise: lobby / between-rounds. Show round results if available.
  return (
    <PageShell team={team} sessionCode={sessionCode} stale={cq.stale} lang={lang} setLang={setLang}>
      <LobbyView
        team={team}
        sessionStatus={sessionStatus}
        sessionCode={sessionCode}
        lang={lang}
      />
    </PageShell>
  );
}

/* --------------- Sub-views --------------- */

function PageShell({ team, sessionCode, stale, lang, setLang, children }) {
  return (
    <div className="page">
      <AppBar
        title={sessionCode}
        right={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <StaleHint stale={stale} />
            {lang && setLang ? <LanguageSwitcher lang={lang} onChange={setLang} light compact /> : null}
            <TeamPill name={team.teamName} />
          </span>
        }
      />
      <main className="page__main">{children}</main>
    </div>
  );
}

function TeamPill({ name }) {
  return (
    <span className="tiny" style={{ color: '#fff', opacity: 0.9 }}>
      {name}
    </span>
  );
}

function LobbyView({ team, sessionStatus, sessionCode, lang }) {
  // Show standings-so-far during round_results, just the waiting state otherwise.
  if (sessionStatus === 'round_results') {
    return (
      <div className="stack-lg">
        <div className="hero" style={{ paddingTop: 'var(--space-3)' }}>
          <p className="hero__label">Round results</p>
          <h1 className="hero__big">Standings so far</h1>
          <p className="muted small">Next question coming up…</p>
        </div>
        <TeamRoundResults sessionCode={sessionCode} team={team} lang={lang} />
      </div>
    );
  }

  // sessionStatus === 'pending' or 'active' (no live question)
  return (
    <div className="stack-lg">
      <div className="hero">
        <p className="hero__label">You're in</p>
        <h1 className="hero__big">{team.teamName}</h1>
      </div>
      <div className="card center">
        <div className="spinner" style={{ margin: '0 auto var(--space-3)' }} aria-hidden="true" />
        <p className="bold">
          {sessionStatus === 'pending' ? 'Waiting for the quiz to start' : 'Waiting for the next question'}
        </p>
        <p className="muted small" style={{ marginTop: 'var(--space-2)' }}>
          We'll refresh automatically when something changes.
        </p>
      </div>
    </div>
  );
}

function QuestionView({ sessionCode, question, paused, team, answeredEntry, onAnswered }) {
  const { t } = useT();
  const [selected, setSelected] = useState(answeredEntry ? answeredEntry.optionId : null);
  const submitAction = useAsyncAction(publicApi.submitAnswer);
  // While paused there is no running deadline; show the frozen remaining time.
  const liveSeconds = useCountdown(paused ? null : question.deadline);
  const frozenSeconds = question.remainingMs != null ? Math.ceil(question.remainingMs / 1000) : null;
  const seconds = paused ? frozenSeconds : liveSeconds;

  // If we land on a different question (admin moved on but we missed the
  // transient state), reset selection.
  useEffect(() => {
    setSelected(answeredEntry ? answeredEntry.optionId : null);
    submitAction.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  const locked = !!answeredEntry && answeredEntry.accepted;
  const disabled = locked || submitAction.busy || paused;

  const onPick = async (optionId) => {
    if (disabled) return;
    setSelected(optionId);
    const result = await submitAction.run(sessionCode, question.id, optionId, team.token);
    if (result.ok) {
      onAnswered(optionId, true);
    } else {
      // If server says "already answered" or session/question state changed,
      // surface a clean message. Either way let the polling loop catch up.
    }
  };

  return (
    <div className="stack-lg">
      {seconds !== null ? (
        <div className="deadline">
          <span className="muted small">{paused ? `${t('team_paused_at')} ` : `${t('team_time_left')} `}</span>
          <span className={`deadline__num ${!paused && seconds <= 5 ? 'deadline__num--low' : ''}${paused ? ' deadline__num--paused' : ''}`}>
            {seconds}s
          </span>
        </div>
      ) : null}

      {paused ? (
        <div className="paused-banner center">⏸ {t('team_paused')}</div>
      ) : null}

      <div>
        <p className="muted small center">
          {t('team_question_n', { n: question.orderIndex })} · {question.points} {t('common_pts')}
        </p>
        <p className="q-prompt">{question.prompt}</p>
      </div>

      {submitAction.error ? (
        <Alert kind="error">
          {submitErrorMessage(submitAction.error)}
        </Alert>
      ) : null}

      {locked ? (
        <Alert kind="success">{t('team_answer_locked')}</Alert>
      ) : null}

      <div className="q-options">
        {question.options.map((opt) => {
          const isSelected = selected === opt.id;
          const classes = ['q-option'];
          if (isSelected) classes.push('q-option--selected');
          return (
            <button
              key={opt.id}
              type="button"
              className={classes.join(' ')}
              onClick={() => onPick(opt.id)}
              disabled={disabled}
            >
              {opt.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function submitErrorMessage(err) {
  if (!err) return 'Something went wrong.';
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your team token is invalid. Try rejoining.';
    if (err.status === 409) return err.message;
    if (err.status === 400) return err.message;
  }
  return err.message;
}

function TeamRoundResults({ sessionCode, team, lang }) {
  const tr = (key, vars) => t(lang, key, vars);
  const fetcher = useCallback(() => publicApi.getCurrentResults(sessionCode, lang), [sessionCode, lang]);
  const { data, loading, error } = usePolling(fetcher, { intervalMs: POLL_RESULTS_MS, deps: [sessionCode, lang] });

  if (loading) return <Spinner label={tr('common_loading')} />;
  if (error) return <Alert kind="error">{error.message}</Alert>;
  if (!data || !data.question) {
    return <p className="muted small">{tr('team_waiting_next')}</p>;
  }

  const myRow = data.results.find((r) => r.teamId === team.teamId) || null;
  const isContest =
    data.question.kind === 'contest' ||
    (!data.correctOption && data.results && data.results.every((r) => !r.selectedOption));

  return (
    <div className="stack">
      <div className="card">
        <p className="muted small">{isContest ? tr('team_contest_n', { n: data.question.orderIndex }) : `Q${data.question.orderIndex}`}</p>
        <p className="bold" style={{ marginTop: 'var(--space-1)' }}>
          {isContest ? <ItemKindBadge kind="contest" /> : null}
          {data.question.prompt}
        </p>
        {!isContest && data.correctOption ? (
          <p className="small" style={{ marginTop: 'var(--space-2)', color: 'var(--color-success)' }}>
            ✓ {tr('team_correct_answer', { answer: data.correctOption.text })}
          </p>
        ) : null}
        {myRow ? (
          <div style={{ marginTop: 'var(--space-3)' }} className="stack-tight">
            {!isContest ? (
              <div className="kv"><span className="kv__k">{tr('team_you_answered')}</span>
                <span className="kv__v">{myRow.answered ? (myRow.isCorrect ? `✓ ${tr('team_correct')}` : `✗ ${tr('team_wrong')}`) : tr('team_no_answer')}</span></div>
            ) : null}
            <div className="kv"><span className="kv__k">{isContest ? tr('team_awarded') : tr('team_points_this_round')}</span>
              <span className="kv__v">+{myRow.pointsAwarded}</span></div>
            <div className="kv"><span className="kv__k">{tr('team_total_so_far')}</span>
              <span className="kv__v">{myRow.cumulativePoints}</span></div>
            <div className="kv"><span className="kv__k">{tr('common_rank')}</span>
              <span className="kv__v">#{myRow.rank}</span></div>
          </div>
        ) : null}
      </div>

      <h2 style={{ fontSize: '1rem' }}>{tr('team_all_teams')}</h2>
      <ul className="standings">
        {data.results.map((r) => (
          <li
            key={r.teamId}
            className={[
              'standing-row',
              !isContest && r.answered ? (r.isCorrect ? 'standing-row--correct' : 'standing-row--wrong') : '',
              r.teamId === team.teamId ? 'standing-row--me' : '',
            ].filter(Boolean).join(' ')}
          >
            <span className="standing-row__rank">{r.rank}</span>
            <span className="standing-row__name">
              {r.teamName} {r.teamId === team.teamId ? <span className="tiny muted">(you)</span> : null}
            </span>
            <span className="standing-row__answered">
              {isContest ? `+${r.pointsAwarded}` : (r.answered ? (r.isCorrect ? `+${r.pointsAwarded}` : '0') : '—')}
            </span>
            <span className="standing-row__points">{r.cumulativePoints}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Team view while a contest is live: title + description + waiting state.
   No options, no submit, no timer. */
function AudioView({ question }) {
  const { t } = useT();
  const description = question.description || t('audio_default_desc');
  return (
    <div className="stack-lg">
      <div className="center">
        <ItemKindBadge kind="audio" />
      </div>
      <div>
        <p className="muted small center">{t('team_audio_n', { n: question.orderIndex })}</p>
        <p className="q-prompt">{question.prompt}</p>
      </div>
      {description ? <p className="muted center">{description}</p> : null}
      <div className="contest-wait">
        <p className="bold">🎧 {t('team_audio_listen')}</p>
        <p className="muted small">{t('team_audio_hint')}</p>
      </div>
    </div>
  );
}

function ContestView({ question }) {
  const { t } = useT();
  return (
    <div className="stack-lg">
      <div className="center">
        <ItemKindBadge kind="contest" />
      </div>
      <div>
        <p className="muted small center">{t('team_contest_max', { n: question.orderIndex, max: question.points })}</p>
        <p className="q-prompt">{question.prompt}</p>
      </div>
      {question.description ? <p className="muted center">{question.description}</p> : null}
      <div className="contest-wait">
        <p className="bold">{t('team_contest_in_progress')}</p>
        <p className="muted small">{t('team_contest_waiting')}</p>
      </div>
    </div>
  );
}

function FinalView({ sessionCode, team, sessionStatus }) {
  const { t } = useT();
  const fetcher = useCallback(() => publicApi.getFinalResults(sessionCode), [sessionCode]);
  const { data, loading, error } = usePolling(fetcher, { intervalMs: 10_000, deps: [sessionCode] });

  if (loading) return <Spinner label={t('common_loading')} />;

  // 409 just means "session closed but final not produced" — show closed view.
  if (error) {
    if (error instanceof ApiError && error.status === 409) {
      return <SessionClosedView />;
    }
    return <Alert kind="error">{error.message}</Alert>;
  }
  if (!data || !data.results || data.results.length === 0) {
    return <SessionClosedView />;
  }

  const myRow = data.results.find((r) => r.teamId === team.teamId) || null;
  const winner = data.results[0] || null;

  return (
    <div className="stack-lg">
      <div className="hero hero--win">
        <p className="hero__label">{sessionStatus === 'closed' ? t('team_session_closed') : t('team_quiz_finished')}</p>
        <h1 className="hero__big">{winner ? t('team_wins', { team: winner.teamName }) : t('team_final_standings')}</h1>
      </div>

      <Podium results={data.results} highlightTeamId={team.teamId} />

      {myRow ? (
        <div className={`card center${myRow.rank <= 3 ? ' card--win' : ''}`}>
          <p className="muted small">{t('team_your_team')}</p>
          <p className="hero__big">#{myRow.rank}</p>
          <p className="bold">{team.teamName}</p>
          <p className="muted">{myRow.totalPoints} {t('common_points')}</p>
        </div>
      ) : null}

      <h2 style={{ fontSize: '1rem' }}>{t('team_full_standings')}</h2>
      <ul className="standings">
        {data.results.map((r) => (
          <li
            key={r.teamId}
            className={`standing-row ${r.teamId === team.teamId ? 'standing-row--me' : ''}${r.rank <= 3 ? ' standing-row--top' : ''}`}
          >
            <span className="standing-row__rank">{r.rank}</span>
            <span className="standing-row__name">
              {r.teamName} {r.teamId === team.teamId ? <span className="tiny muted">({t('common_you')})</span> : null}
            </span>
            <span />
            <span className="standing-row__points">{r.totalPoints}</span>
          </li>
        ))}
      </ul>

      <p className="center muted small">{t('team_thanks')}</p>
    </div>
  );
}

function SessionClosedView() {
  const { t } = useT();
  return (
    <div className="stack-lg">
      <div className="hero">
        <p className="hero__label">{t('team_session_closed')}</p>
        <h1 className="hero__big">{t('team_session_ended')}</h1>
      </div>
      <div className="card center">
        <p>{t('team_session_ended_sub')}</p>
      </div>
    </div>
  );
}
