import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../../api/client.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert } from '../../components/ui.jsx';

export default function CreateQuiz() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const { run, busy, error } = useAsyncAction(adminApi.createQuiz);

const onSubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  const result = await run({
    title: title.trim(),
    description: description.trim() || undefined,
  });
  if (result.ok) {
    navigate(`/admin/quizzes/${result.value.id}`, {
      replace: true,
      state: { quiz: result.value, justCreated: true },
    });
  }
};

  return (
    <div className="page">
      <AppBar title="New quiz" back backTo="/admin" />
      <main className="page__main">
        <form onSubmit={onSubmit} className="stack">
          <h1>Create a quiz</h1>
          <p className="muted">Give it a title and an optional description.
            You'll add questions on the next screen.</p>

          {error ? <Alert kind="error">{error.message}</Alert> : null}

          <div className="field">
            <label className="field__label" htmlFor="title">Title</label>
            <input
              id="title"
              className="input"
              maxLength={255}
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Bratislava Old Town"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="desc">Description (optional)</label>
            <textarea
              id="desc"
              className="textarea"
              rows={3}
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <button type="submit" className="btn" disabled={busy || title.trim().length === 0}>
            {busy ? 'Creating…' : 'Create quiz'}
          </button>
        </form>
      </main>
    </div>
  );
}
