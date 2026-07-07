import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';

/*
 * Most people arrive via QR (which goes straight to /join/:code), so this
 * page exists mostly for the admin shortcut and a fallback "I have a code"
 * input for anyone who got here without scanning.
 */
export default function Landing() {
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  const onJoin = (e) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean.length === 0) return;
    navigate(`/join/${encodeURIComponent(clean)}`);
  };

  return (
    <div className="page">
      <header className="appbar">
        <span className="appbar__title">Bratislava Bike Quiz</span>
      </header>
      <main className="page__main">
        <div className="stack-lg">
          <div className="hero" style={{ paddingTop: 'var(--space-4)' }}>
            <p className="hero__label">Live tour quizzes</p>
            <h1 className="hero__big" style={{ marginBottom: 0 }}>Bratislava Bike</h1>
          </div>

          <form onSubmit={onJoin} className="card stack">
            <h2 style={{ fontSize: '1.0625rem' }}>Have a session code?</h2>
            <div className="field">
              <label className="field__label" htmlFor="code">Session code</label>
              <input
                id="code"
                className="input mono"
                inputMode="latin"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck="false"
                maxLength={12}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. K7XQ24"
              />
            </div>
            <button type="submit" className="btn" disabled={code.trim().length === 0}>
              Join session
            </button>
          </form>

          <div className="center">
            <Link to="/admin/login" className="btn btn--ghost btn--small" style={{ display: 'inline-flex' }}>
              Admin sign-in →
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
