import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../../api/client.js';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';

/*
 * Quiz management list. Shows all non-archived quizzes by default with an
 * "include archived" toggle. Each row links to the editor; archived quizzes
 * are visually marked and cannot be used for new sessions.
 *
 * Phase 1C-C: create/import/duplicate surfaces hidden when
 * `challenges.create_quiz` is off. Backend already enforces.
 */
export default function QuizList() {
  const navigate = useNavigate();
  const { can } = useAdminAuth();
  const [quizzes, setQuizzes] = useState(null);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.listQuizzes(undefined, showArchived);
      setQuizzes(res.quizzes || []);
    } catch (err) {
      setError(err);
      setQuizzes([]);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  const onDuplicate = async (e, quizId) => {
    e.stopPropagation();
    if (busyId) return;
    setBusyId(quizId);
    setError(null);
    try {
      const created = await adminApi.duplicateQuiz(quizId);
      // Jump straight into editing the new copy.
      navigate(`/admin/quizzes/${created.id}/edit`);
    } catch (err) {
      setError(err);
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <AppBar title="Manage quizzes" back backTo="/admin" />
      <main className="page__main">
        <div className="stack-lg">
          <div className="row row--between">
            <h1>Quizzes</h1>
            {can('challenges.create_quiz') ? (
              <span className="row" style={{ gap: 'var(--space-2)' }}>
                <Link to="/admin/quizzes/import" className="btn btn--secondary btn--small" style={{ display: 'inline-flex' }}>
                  Import
                </Link>
                <Link to="/admin/quizzes/new" className="btn btn--small" style={{ display: 'inline-flex' }}>
                  + New
                </Link>
              </span>
            ) : null}
          </div>

          {error ? <Alert kind="error">{error.message}</Alert> : null}

          <label className="checkbox" style={{ maxWidth: '14rem' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span className="small">Show archived</span>
          </label>

          {quizzes === null ? (
            <Spinner label="Loading quizzes…" />
          ) : quizzes.length === 0 ? (
            <div className="card stack">
              <p>No quizzes yet.</p>
              {can('challenges.create_quiz') ? (
                <Link to="/admin/quizzes/new" className="btn">Create your first quiz</Link>
              ) : null}
            </div>
          ) : (
            <ul className="stack-tight">
              {quizzes.map((q) => (
                <li
                  key={q.id}
                  className="tile"
                  onClick={() => navigate(`/admin/quizzes/${q.id}/edit`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/quizzes/${q.id}/edit`); }}
                >
                  <div className="row row--between">
                    <span className="tile__title">{q.title}</span>
                    {q.isArchived ? <span className="badge badge--closed">archived</span> : null}
                  </div>
                  <div className="tile__sub">
                    {q.questionCount} {q.questionCount === 1 ? 'question' : 'questions'}
                    {' · '}
                    {(q.languages || []).map((c) => c.toUpperCase()).join(' / ')}
                  </div>
                  {can('challenges.create_quiz') ? (
                    <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                      <button
                        className="btn btn--secondary btn--small"
                        onClick={(e) => onDuplicate(e, q.id)}
                        disabled={busyId === q.id}
                      >
                        {busyId === q.id ? 'Duplicating…' : 'Duplicate'}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
