import { useState } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';
import { ApiError } from '../../api/client.js';

export default function AdminLogin() {
  const { admin, loading, login } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { run, busy, error } = useAsyncAction(login);

  // Don't render the form while we're still checking the existing session.
  if (loading) {
    return <div className="page"><main className="page__main"><Spinner label="Checking session…" /></main></div>;
  }
  if (admin) {
    const target = (location.state && location.state.from) || '/admin/menu';
    return <Navigate to={target} replace />;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const result = await run(username, password);
    if (result.ok) {
      const target = (location.state && location.state.from) || '/admin/menu';
      navigate(target, { replace: true });
    }
  };

  const errorMessage = error
    ? (error instanceof ApiError && error.status === 401
        ? 'Invalid username or password.'
        : error.message)
    : null;

  return (
    <div className="page">
      <AppBar title="Admin sign-in" />
      <main className="page__main">
        <form onSubmit={onSubmit} className="stack">
          <div className="hero" style={{ paddingBottom: 'var(--space-3)' }}>
            <h1>Welcome back</h1>
            <p className="muted">Sign in to manage your quizzes</p>
          </div>

          {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}

          <div className="field">
            <label className="field__label" htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck="false"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn"
            disabled={busy || username.length === 0 || password.length === 0}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    </div>
  );
}
