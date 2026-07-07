import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { adminApi } from '../../api/client.js';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';

/*
 * Start a new session.
 *
 * Loads quizzes through the picker endpoint (gated only on `challenges`)
 * rather than the management list (gated on `challenges.manage_quizzes`).
 * That way an operator who can host but not author quizzes still gets a
 * working picker.
 *
 * Empty-state copy adapts: an admin who CAN create quizzes sees a CTA;
 * one who can't sees a friendly "ask a manager" note instead of a
 * misleading create button.
 */
export default function CreateSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const preset = location.state || {};
  const { can } = useAdminAuth();

  const [quizzes, setQuizzes] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [quizId, setQuizId] = useState(preset.quizId ? String(preset.quizId) : '');
  const [answerTime, setAnswerTime] = useState('30');

  const { run, busy, error } = useAsyncAction(adminApi.createSession);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await adminApi.listQuizzesForHosting();
      setQuizzes(res.quizzes || []);
      if (!quizId && res.quizzes && res.quizzes.length) {
        setQuizId(String(res.quizzes[0].id));
      }
    } catch (err) {
      setLoadError(err);
      setQuizzes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const qId = Number(quizId);
    if (!Number.isInteger(qId) || qId < 1) return;
    const at = Number(answerTime);
    if (!Number.isInteger(at) || at < 5 || at > 3600) return;

    const result = await run({ quizId: qId, answerTimeSeconds: at });
    if (result.ok) {
      navigate(`/admin/sessions/${result.value.session.sessionCode}`, { replace: true });
    }
  };

  const canCreate = can('challenges.create_quiz');

  return (
    <div className="page">
      <AppBar title="New session" back backTo="/admin" />
      <main className="page__main">
        <form onSubmit={onSubmit} className="stack">
          <h1>Start a session</h1>
          <p className="muted">A session runs one quiz for one tour group.</p>

          {error ? <Alert kind="error">{error.message}</Alert> : null}
          {loadError ? <Alert kind="error">Couldn't load quizzes: {loadError.message}</Alert> : null}

          {quizzes === null ? (
            <Spinner label="Loading quizzes…" />
          ) : quizzes.length === 0 ? (
            <div className="card stack">
              {canCreate ? (
                <>
                  <p>You don't have any quizzes yet.</p>
                  <Link to="/admin/quizzes/new" className="btn">Create your first quiz</Link>
                </>
              ) : (
                <p>No quizzes available yet. Ask a manager to create one.</p>
              )}
            </div>
          ) : (
            <>
              <div className="field">
                <label className="field__label" htmlFor="quiz">Quiz</label>
                <select
                  id="quiz"
                  className="select"
                  value={quizId}
                  onChange={(e) => setQuizId(e.target.value)}
                  required
                >
                  {quizzes.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.title} ({q.questionCount} {q.questionCount === 1 ? 'question' : 'questions'})
                    </option>
                  ))}
                </select>
                <p className="field__hint">
                  Pick by title — the correct quiz ID is submitted automatically.
                </p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="time">Answer time per question</label>
                <input
                  id="time"
                  className="input"
                  type="number"
                  min={5}
                  max={3600}
                  inputMode="numeric"
                  required
                  value={answerTime}
                  onChange={(e) => setAnswerTime(e.target.value)}
                  style={{ maxWidth: '8rem' }}
                />
                <p className="field__hint">In seconds (5–3600). You close each question manually.</p>
              </div>

              <button type="submit" className="btn" disabled={busy || !quizId}>
                {busy ? 'Creating…' : 'Create session'}
              </button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
