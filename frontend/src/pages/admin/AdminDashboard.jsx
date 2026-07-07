import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner, StatusBadge } from '../../components/ui.jsx';
import { LanguageSwitcher } from '../../components/LanguageSwitcher.jsx';
import { adminApi } from '../../api/client.js';
import { useT } from '../../i18n/ui.js';

// Statuses that count as "ongoing" — these belong on the dashboard for quick
// reopening. Finished/closed sessions live in Session History instead.
const ACTIVE_STATUSES = new Set(['pending', 'active', 'round_results']);

export default function AdminDashboard() {
  const { admin, logout, can } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const [sessions, setSessions] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Issue 1: only fetch + render the Active Sessions block when the admin
  // is actually allowed to read session history. Without this, the page
  // shows a "Couldn't load sessions: Forbidden" error block to admins who
  // are simply not entitled to that view.
  const canHistory = can('challenges.session_history');

  const load = useCallback(async () => {
    if (!canHistory) return;
    try {
      const res = await adminApi.listSessions();
      setSessions(Array.isArray(res) ? res : (res.sessions || []));
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    }
  }, [canHistory]);

  useEffect(() => {
    if (!canHistory) return undefined;
    load();
    // Light polling so a newly started session appears without manual refresh.
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load, canHistory]);

  const active = (sessions || []).filter((s) => ACTIVE_STATUSES.has(s.status));

  const onLogout = async () => {
    await logout();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="page">
      <AppBar
        title={tr('dash_title')}
        back
        backTo="/admin/menu"
        right={
          <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} compact />
            <button className="appbar__action" onClick={onLogout}>
              {tr('common_sign_out')}
            </button>
          </span>
        }
      />
      <main className="page__main">
        <div className="stack-lg">
          <div>
            <p className="muted small">{tr('common_signed_in_as')}</p>
            <p className="bold">{admin && admin.username}</p>
          </div>

          {/* Active sessions — open one directly without typing a code.
              Issue 1: only rendered if the admin can read session history;
                       no fetch happens otherwise, no error block appears.
              Issue 2: "New session" gated on `challenges` (operator can host).
              Issue 3: per-card "Open" button only for owner or super_admin;
                       others see a small "view-only" hint. */}
          {canHistory ? (
            <section className="stack">
              <div className="row row--between">
                <h2 style={{ fontSize: '1rem' }}>{tr('dash_active_sessions')}</h2>
                {can('challenges') ? (
                  <Link to="/admin/sessions/new" className="btn btn--accent btn--small">{tr('dash_new_session')}</Link>
                ) : null}
              </div>

              {loadError ? (
                <Alert kind="error">{tr('dash_load_failed', { msg: loadError.message })}</Alert>
              ) : null}

              {sessions === null && !loadError ? (
                <Spinner label={tr('dash_loading_sessions')} />
              ) : null}

              {sessions !== null && active.length === 0 && !loadError ? (
                <div className="card">
                  <p className="muted small">
                    {tr('dash_no_active')}
                    {' '}<Link to="/admin/sessions">{tr('dash_session_history_link')}</Link>.
                  </p>
                </div>
              ) : null}

              {active.map((s) => {
                const isOwner = s.createdBy != null && admin && Number(s.createdBy) === Number(admin.id);
                const canControl = admin && (admin.role === 'super_admin' || isOwner || s.createdBy == null);
                return (
                  <div key={s.id || s.sessionCode} className="card session-card">
                    <div className="session-card__main">
                      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="bold">{s.quizTitle}</span>
                        <StatusBadge status={s.status} />
                        {!canControl && s.createdByUsername ? (
                          <span className="tiny muted">{tr('sessions_started_by', { name: s.createdByUsername })}</span>
                        ) : null}
                      </div>
                      <p className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>
                        <span className="mono">{s.sessionCode}</span>
                        {' · '}{s.teamCount} {s.teamCount === 1 ? tr('common_team') : tr('common_teams')}
                        {s.startedAt
                          ? <> · {tr('dash_started', { time: fmtTime(s.startedAt) })}</>
                          : (s.createdAt ? <> · {tr('dash_created', { time: fmtTime(s.createdAt) })}</> : null)}
                      </p>
                    </div>
                    {canControl ? (
                      <Link
                        to={`/admin/sessions/${encodeURIComponent(s.sessionCode)}`}
                        className="btn btn--accent btn--small session-card__open"
                      >
                        {tr('common_open')}
                      </Link>
                    ) : (
                      <span className="tiny muted session-card__open">{tr('sessions_view_only')}</span>
                    )}
                  </div>
                );
              })}
            </section>
          ) : null}

          <div className="stack">
            {can('challenges.create_quiz') ? (
              <Link to="/admin/quizzes/new" className="tile">
                <div className="tile__title">{tr('dash_create_quiz')}</div>
                <div className="tile__sub">{tr('dash_create_quiz_sub')}</div>
              </Link>
            ) : null}

            {can('challenges.manage_quizzes') ? (
              <Link to="/admin/quizzes" className="tile">
                <div className="tile__title">{tr('dash_manage_quizzes')}</div>
                <div className="tile__sub">{tr('dash_manage_quizzes_sub')}</div>
              </Link>
            ) : null}

            {can('challenges') ? (
              <Link to="/admin/sessions/new" className="tile">
                <div className="tile__title">{tr('dash_start_session')}</div>
                <div className="tile__sub">{tr('dash_start_session_sub')}</div>
              </Link>
            ) : null}

            {can('challenges.session_history') ? (
              <Link to="/admin/sessions" className="tile">
                <div className="tile__title">{tr('dash_history')}</div>
                <div className="tile__sub">{tr('dash_history_sub')}</div>
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
