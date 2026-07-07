import { useNavigate } from 'react-router-dom';

export function AppBar({ title, back = false, backTo, right }) {
  const navigate = useNavigate();

  const onBack = () => {
    if (backTo) navigate(backTo);
    else navigate(-1);
  };

  return (
    <header className="appbar">
      {back ? (
        <button className="appbar__back" onClick={onBack} aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12.5 16 6 10l6.5-6" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      ) : null}
      <span className="appbar__title">{title}</span>
      <span className="appbar__spacer" />
      {right || null}
    </header>
  );
}
