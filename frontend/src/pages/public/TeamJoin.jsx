import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { publicApi, ApiError } from '../../api/client.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { saveTeamSession, loadTeamSession } from '../../auth/teamStorage.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert } from '../../components/ui.jsx';

export default function TeamJoin() {
  const { sessionCode } = useParams();
  const navigate = useNavigate();
  const [teamName, setTeamName] = useState('');
  const { run, busy, error } = useAsyncAction(publicApi.join);

  // If we already have a saved session for this code, skip straight to play.
  useEffect(() => {
    const existing = loadTeamSession(sessionCode);
    if (existing) {
      navigate(`/play/${encodeURIComponent(sessionCode)}`, { replace: true });
    }
  }, [sessionCode, navigate]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = teamName.trim();
    if (name.length < 2) return;
    const result = await run(sessionCode, name);
    if (result.ok) {
      saveTeamSession(sessionCode, {
        sessionCode,
        teamId: result.value.team.id,
        teamName: result.value.team.name,
        joinedAt: result.value.team.joinedAt,
        token: result.value.token,
      });
      navigate(`/play/${encodeURIComponent(sessionCode)}`, { replace: true });
    }
  };

  const errorMessage = error ? (
    error instanceof ApiError && error.status === 404 ? "We couldn't find that session. Double-check the code." :
    error instanceof ApiError && error.status === 409 ? error.message :
    error.message
  ) : null;

  return (
    <div className="page">
      <AppBar title="Join quiz" />
      <main className="page__main">
        <div className="stack-lg">
          <div className="hero" style={{ paddingTop: 'var(--space-3)' }}>
            <p className="hero__label">Session code</p>
            <p className="hero__code">{sessionCode}</p>
          </div>

          <form onSubmit={onSubmit} className="stack">
            <h1 className="center">Pick a team name</h1>

            {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}

            <div className="field">
              <label className="field__label" htmlFor="teamName">Team name</label>
              <input
                id="teamName"
                className="input"
                autoFocus
                autoComplete="off"
                spellCheck="false"
                minLength={2}
                maxLength={100}
                required
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. The Wheelers"
              />
              <p className="field__hint">2–100 characters. Other teams in this session can't use the same name.</p>
            </div>

            <button type="submit" className="btn btn--accent"
                    disabled={busy || teamName.trim().length < 2}>
              {busy ? 'Joining…' : 'Join'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
