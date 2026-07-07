import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { adminApi } from '../../api/client.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';

/*
 * Bulk import a quiz from an .xlsx workbook.
 *   Step 1: choose a file → server parses + validates → preview.
 *   Step 2: if valid, Commit → creates the quiz and opens it in the editor.
 *
 * The server returns a normalized `payload`; we send that straight back to
 * commit, so the file is uploaded only once.
 */
export default function ImportQuiz() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      const res = await adminApi.importPreview(file);
      setPreview(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    if (!preview || !preview.ok || !preview.payload) return;
    setBusy(true);
    setError(null);
    try {
      const created = await adminApi.importCommit(preview.payload);
      navigate(`/admin/quizzes/${created.id}/edit`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const reset = () => {
    setPreview(null);
    setFileName('');
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page">
      <AppBar title="Import quiz" back backTo="/admin/quizzes" />
      <main className="page__main">
        <div className="stack-lg">
          <h1>Import a quiz</h1>

          {error ? <Alert kind="error">{error.message}</Alert> : null}

          <section className="card stack">
            <h2 style={{ fontSize: '1rem' }}>1. Choose an .xlsx file</h2>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onPick}
              disabled={busy}
            />
            {fileName ? <p className="tiny muted">Selected: {fileName}</p> : null}
            {busy && !preview ? <Spinner label="Reading file…" /> : null}
          </section>

          <FormatHelp />

          {preview ? (
            <PreviewPanel preview={preview} onCommit={onCommit} onReset={reset} busy={busy} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PreviewPanel({ preview, onCommit, onReset, busy }) {
  const { ok, errors, summary, questions } = preview;
  return (
    <section className="stack">
      <h2 style={{ fontSize: '1rem' }}>2. Preview</h2>

      {errors && errors.length > 0 ? (
        <Alert kind="error">
          <strong>{errors.length} problem{errors.length === 1 ? '' : 's'} found:</strong>
          <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.2em' }}>
            {errors.map((e, i) => (
              <li key={i} className="small">
                {e.scope}{e.row ? ` (row ${e.row})` : ''}: {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {summary ? (
        <div className="card stack-tight">
          <div className="kv"><span className="kv__k">Title</span><span className="kv__v">{summary.title}</span></div>
          <div className="kv"><span className="kv__k">Languages</span><span className="kv__v">{summary.languages.map((l) => l.toUpperCase()).join(', ')}</span></div>
          <div className="kv"><span className="kv__k">Questions</span><span className="kv__v">{summary.questionCount}</span></div>
        </div>
      ) : null}

      {questions && questions.length > 0 ? (
        <ul className="stack-tight">
          {questions.map((q) => (
            <li key={q.orderIndex} className="tile">
              <div className="row row--between">
                <span className="tile__title">Q{q.orderIndex}. {q.prompt}</span>
                <span className="tiny muted">{q.points} pts</span>
              </div>
              <div className="tile__sub tiny">
                {q.options.map((opt, i) => (
                  <span key={i} className={i === q.correctIndex ? 'tag-correct' : ''}>
                    {i === q.correctIndex ? '✓ ' : ''}{opt}{i < q.options.length - 1 ? '  ·  ' : ''}
                  </span>
                ))}
              </div>
              <div className="tiny muted">
                {q.languages.map((l) => l.toUpperCase()).join(', ')}
                {q.hasExplanation ? ' · has explanation' : ''}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="btn-row">
        <button className="btn btn--accent" onClick={onCommit} disabled={!ok || busy}>
          {busy ? 'Importing…' : ok ? `Import ${summary ? summary.questionCount : ''} questions` : 'Fix errors to import'}
        </button>
        <button className="btn btn--secondary" onClick={onReset} disabled={busy}>Choose another file</button>
      </div>
    </section>
  );
}

function FormatHelp() {
  return (
    <details className="card">
      <summary className="bold" style={{ cursor: 'pointer' }}>Expected file format</summary>
      <div className="stack-tight" style={{ marginTop: 'var(--space-3)' }}>
        <p className="small">One <strong>.xlsx</strong> file = one quiz, with two sheets:</p>
        <p className="small">
          <strong>Meta</strong> — columns: <code>lang</code>, <code>title</code>, <code>description</code>.
          One row per language (en / sk / de). Title required.
        </p>
        <p className="small">
          <strong>Questions</strong> — one row per question, columns:
          <code>order</code>, <code>points</code> (1–1000), <code>correct</code> (the
          correct option number, 1-based), then per language:
          <code>prompt_en</code>, <code>opt1_en</code>…<code>opt4_en</code>,
          <code>explanation_en</code> (optional), and the same with <code>_sk</code> / <code>_de</code>.
        </p>
        <p className="tiny muted">
          A language is included for a question when its <code>prompt_&lt;lang&gt;</code> is filled;
          then its prompt and all options are required, and the number of options must match across
          languages. Explanations are optional.
        </p>
      </div>
    </details>
  );
}
