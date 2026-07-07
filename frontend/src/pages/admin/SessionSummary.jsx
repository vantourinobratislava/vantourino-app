import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { adminApi, ApiError } from '../../api/client.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner, StatusBadge } from '../../components/ui.jsx';

/*
 * Read-only summary of a past (or in-progress) session: metadata, teams, and
 * standings (final if finalized, otherwise the latest cumulative standings).
 */
export default function SessionSummary() {
  const { sessionCode } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.getSessionSummary(sessionCode);
      setData(res);
    } catch (err) {
      setError(err);
    }
  }, [sessionCode]);

  useEffect(() => { load(); }, [load]);

  const onDelete = async () => {
    if (!window.confirm(
      `Delete session ${sessionCode}? This removes its teams and results permanently. The quiz itself is not affected.`
    )) return;
    try {
      await adminApi.deleteSession(sessionCode);
      navigate('/admin/sessions', { replace: true });
    } catch (err) {
      setError(err);
    }
  };

  if (error) {
    return (
      <div className="page">
        <AppBar title="Session summary" back backTo="/admin/sessions" />
        <main className="page__main">
          <Alert kind="error">
            {error instanceof ApiError && error.status === 404 ? 'Session not found.' : error.message}
          </Alert>
        </main>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <AppBar title="Session summary" back backTo="/admin/sessions" />
        <main className="page__main"><Spinner label="Loading…" /></main>
      </div>
    );
  }

  const s = data.session;

  return (
    <div className="page">
      <AppBar title="Session summary" back backTo="/admin/sessions" />
      <main className="page__main">
        <div className="stack-lg">
          <div className="row row--between" style={{ alignItems: 'flex-start' }}>
            <div>
              <p className="muted small">Session code</p>
              <p className="mono bold" style={{ fontSize: '1.4rem', letterSpacing: '0.12em' }}>{s.sessionCode}</p>
            </div>
            <StatusBadge status={s.status} />
          </div>

          <section className="card stack-tight">
            <div className="kv"><span className="kv__k">Created</span><span className="kv__v">{fmt(s.createdAt)}</span></div>
            {s.startedAt ? <div className="kv"><span className="kv__k">Started</span><span className="kv__v">{fmt(s.startedAt)}</span></div> : null}
            {s.endedAt ? <div className="kv"><span className="kv__k">Ended</span><span className="kv__v">{fmt(s.endedAt)}</span></div> : null}
            <div className="kv"><span className="kv__k">Teams</span><span className="kv__v">{data.teams.length}</span></div>
            <div className="kv"><span className="kv__k">Rounds played</span><span className="kv__v">{data.roundsPlayed}</span></div>
          </section>

          <section className="stack-tight">
            <h2 style={{ fontSize: '1rem' }}>
              {data.standingsType === 'final' ? 'Final standings'
                : data.standingsType === 'partial' ? 'Standings so far' : 'Standings'}
            </h2>
            {data.standings.length === 0 ? (
              <p className="muted small">No standings recorded.</p>
            ) : (
              <ul className="standings">
                {data.standings.map((r) => (
                  <li key={r.teamId} className="standing-row">
                    <span className="standing-row__rank">#{r.rank}</span>
                    <span className="standing-row__name">{r.teamName}</span>
                    <span />
                    <span className="standing-row__points">{r.points}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="stack-tight">
            <h2 style={{ fontSize: '1rem' }}>Teams ({data.teams.length})</h2>
            {data.teams.length === 0 ? (
              <p className="muted small">No teams joined.</p>
            ) : (
              <ul className="standings">
                {data.teams.map((t) => (
                  <li key={t.id} className="standing-row" style={{ gridTemplateColumns: '1fr auto' }}>
                    <span className="standing-row__name">{t.name}</span>
                    <span className="tiny muted">{fmt(t.joinedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card stack">
            <h2 style={{ fontSize: '1rem' }}>Danger zone</h2>
            <p className="muted small">Deleting removes this session's teams and results. The quiz is not affected.</p>
            <button className="btn btn--danger" onClick={onDelete}>Delete session</button>
          </section>
        </div>
      </main>
    </div>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
