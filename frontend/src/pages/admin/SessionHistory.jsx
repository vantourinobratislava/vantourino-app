import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../../api/client.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner, StatusBadge } from '../../components/ui.jsx';

/*
 * Session history. Lists every session (newest first) with quiz name, dates,
 * team count, and status. Open one for a read-only summary, or delete it
 * (removes its history/results but never the quiz).
 */
export default function SessionHistory() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [busyCode, setBusyCode] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.listSessions();
      setSessions(res.sessions || []);
    } catch (err) {
      setError(err);
      setSessions([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onDelete = async (e, code) => {
    e.stopPropagation();
    if (busyCode) return;
    if (!window.confirm(
      `Delete session ${code}? This removes its teams and results permanently. The quiz itself is not affected.`
    )) return;
    setBusyCode(code);
    setError(null);
    try {
      await adminApi.deleteSession(code);
      setSessions((list) => (list || []).filter((s) => s.sessionCode !== code));
    } catch (err) {
      setError(err);
    } finally {
      setBusyCode(null);
    }
  };

  return (
    <div className="page">
      <AppBar title="Session history" back backTo="/admin" />
      <main className="page__main">
        <div className="stack-lg">
          <h1>Sessions</h1>
          {error ? <Alert kind="error">{error.message}</Alert> : null}

          {sessions === null ? (
            <Spinner label="Loading sessions…" />
          ) : sessions.length === 0 ? (
            <div className="card stack">
              <p className="muted">No sessions yet.</p>
              <Link to="/admin/sessions/new" className="btn">Start a session</Link>
            </div>
          ) : (
            <ul className="stack-tight">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="tile"
                  onClick={() => navigate(`/admin/sessions/${s.sessionCode}/summary`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/sessions/${s.sessionCode}/summary`); }}
                >
                  <div className="row row--between">
                    <span className="tile__title mono">{s.sessionCode}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="tile__sub">{s.quizTitle}</div>
                  <div className="tile__sub tiny">
                    {fmtDate(s.createdAt)} · {s.teamCount} {s.teamCount === 1 ? 'team' : 'teams'}
                    {s.endedAt ? ` · ended ${fmtTime(s.endedAt)}` : ''}
                  </div>
                  <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                    <button
                      className="btn btn--danger btn--small"
                      onClick={(e) => onDelete(e, s.sessionCode)}
                      disabled={busyCode === s.sessionCode}
                    >
                      {busyCode === s.sessionCode ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}
function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
