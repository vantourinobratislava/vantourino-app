import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { adminApi, ApiError, audioApi } from '../../api/client.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';
import { ItemKindBadge } from '../../components/ItemKindBadge.jsx';
import { LANGS } from '../../i18n/lang.js';
import { useT } from '../../i18n/ui.js';

/*
 * Quiz editor.
 *
 * Loads the full multilingual quiz (GET /api/admin/quizzes/:id) and lets the
 * admin edit:
 *   - title/description per language  (PATCH /api/admin/quizzes/:id)
 *   - each question's prompt/options/points/correct option per language
 *     (PATCH /api/admin/quizzes/:id/questions/:qid)
 *   - delete/archive the quiz         (DELETE /api/admin/quizzes/:id)
 *
 * Each section saves independently so the form stays simple on mobile and a
 * failure in one place doesn't lose work elsewhere. Option structure (count /
 * which exist) is fixed here — only text/points/correct change — matching the
 * backend's safe-edit contract. To add questions, use the "add questions"
 * screen; to restructure options, recreate the question.
 */
export default function EditQuiz() {
  const { quizId } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null);      // { quiz, sessionRefs, usedInSessions }
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await adminApi.getQuiz(quizId);
      setData(res);
    } catch (err) {
      setLoadError(err);
    }
  }, [quizId]);

  useEffect(() => { load(); }, [load]);

  if (loadError) {
    return (
      <div className="page">
        <AppBar title="Edit quiz" back backTo="/admin/quizzes" />
        <main className="page__main">
          <Alert kind="error">
            {loadError instanceof ApiError && loadError.status === 404
              ? 'Quiz not found.' : loadError.message}
          </Alert>
        </main>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <AppBar title="Edit quiz" back backTo="/admin/quizzes" />
        <main className="page__main"><Spinner label="Loading quiz…" /></main>
      </div>
    );
  }

  const { quiz, usedInSessions } = data;

  return (
    <div className="page">
      <AppBar title="Edit quiz" back backTo="/admin/quizzes" />
      <main className="page__main page__main--wide">
        <div className="stack-lg">
          {usedInSessions ? (
            <Alert kind="info">
              This quiz has been used in a session. You can edit text, points, and the
              correct answer; changes apply to future sessions only.
            </Alert>
          ) : null}

          <MetadataEditor quiz={quiz} onSaved={load} />

          {quiz.questions.length > 1 ? (
            <QuestionReorder quiz={quiz} onReordered={load} />
          ) : null}

          <section className="stack">
            <h2>Questions</h2>
            {quiz.questions.length === 0 ? (
              <p className="muted small">No questions yet.</p>
            ) : (
              quiz.questions.map((q) => (
                <QuestionEditor key={q.id} quizId={quiz.id} question={q} onSaved={load} />
              ))
            )}
            <button
              className="btn btn--secondary"
              onClick={() => navigate(`/admin/quizzes/${quiz.id}`, { state: { quiz: { id: quiz.id, title: quiz.translations.en?.title || `Quiz #${quiz.id}` } } })}
            >
              + Add more questions
            </button>
          </section>

          <DeleteQuizSection quizId={quiz.id} usedInSessions={usedInSessions} />
        </div>
      </main>
    </div>
  );
}

/* ---------------- Metadata editor ---------------- */

function MetadataEditor({ quiz, onSaved }) {
  const [activeLang, setActiveLang] = useState('en');
  const [byLang, setByLang] = useState(() => {
    const init = {};
    for (const l of LANGS) {
      const t = quiz.translations[l.code];
      init[l.code] = { title: t?.title || '', description: t?.description || '' };
    }
    return init;
  });
  const [formError, setFormError] = useState(null);
  const [saved, setSaved] = useState(false);
  const { run, busy, error } = useAsyncAction(adminApi.updateQuiz);

  const setField = (lang, field, value) =>
    setByLang((m) => ({ ...m, [lang]: { ...m[lang], [field]: value } }));

  const filledLangs = LANGS.filter((l) => byLang[l.code].title.trim().length > 0).map((l) => l.code);

  const onSave = async () => {
    setFormError(null);
    setSaved(false);
    const translations = {};
    for (const l of LANGS) {
      const t = byLang[l.code];
      if (t.title.trim().length > 0) {
        translations[l.code] = { title: t.title.trim(), description: t.description.trim() || undefined };
      }
    }
    if (Object.keys(translations).length === 0) {
      setFormError('Enter a title in at least one language.');
      return;
    }
    const result = await run(quiz.id, { translations });
    if (result.ok) {
      setSaved(true);
      onSaved();
    }
  };

  const cur = byLang[activeLang];
  const errorMessage = formError || (error && error.message);

  return (
    <section className="card stack">
      <h2 style={{ fontSize: '1.0625rem' }}>Quiz details</h2>
      {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}
      {saved ? <Alert kind="success">Saved.</Alert> : null}

      <div className="lang-tabs" role="tablist" aria-label="Quiz languages">
        {LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            role="tab"
            aria-selected={activeLang === l.code}
            className={`lang-tab${activeLang === l.code ? ' lang-tab--active' : ''}${filledLangs.includes(l.code) ? ' lang-tab--filled' : ''}`}
            onClick={() => setActiveLang(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`title-${activeLang}`}>Title ({activeLang.toUpperCase()})</label>
        <input
          id={`title-${activeLang}`}
          className="input"
          maxLength={255}
          value={cur.title}
          onChange={(e) => setField(activeLang, 'title', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`desc-${activeLang}`}>Description ({activeLang.toUpperCase()}, optional)</label>
        <textarea
          id={`desc-${activeLang}`}
          className="textarea"
          rows={2}
          maxLength={5000}
          value={cur.description}
          onChange={(e) => setField(activeLang, 'description', e.target.value)}
        />
      </div>

      <button className="btn" onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : 'Save details'}
      </button>
    </section>
  );
}

/* ---------------- Question editor ---------------- */

function QuestionEditor({ quizId, question, onSaved }) {
  const [activeLang, setActiveLang] = useState('en');
  const [points, setPoints] = useState(String(question.points));
  const [prompts, setPrompts] = useState(() => {
    const p = {};
    for (const l of LANGS) p[l.code] = question.prompts[l.code] || '';
    return p;
  });
  const [explanations, setExplanations] = useState(() => {
    const e = {};
    for (const l of LANGS) e[l.code] = (question.explanations && question.explanations[l.code]) || '';
    return e;
  });
  // option text per language, keyed by option id
  const [optTexts, setOptTexts] = useState(() => {
    const m = {};
    for (const o of question.options) {
      m[o.id] = {};
      for (const l of LANGS) m[o.id][l.code] = (o.texts && o.texts[l.code]) || '';
    }
    return m;
  });
  const [correctId, setCorrectId] = useState(() => {
    const c = question.options.find((o) => o.isCorrect);
    return c ? c.id : (question.options[0] && question.options[0].id);
  });
  const [audioUrl, setAudioUrl] = useState(question.audioUrl || '');
  const [audioGuideId, setAudioGuideId] = useState(
    question.audioGuideId == null ? '' : String(question.audioGuideId)
  );
  const [guides, setGuides] = useState(null);
  useEffect(() => {
    if (question.kind !== 'audio') return;
    let cancelled = false;
    audioApi.listGuides()
      .then((d) => { if (!cancelled) setGuides(d.guides || []); })
      .catch(() => { if (!cancelled) setGuides([]); });
    return () => { cancelled = true; };
  }, [question.kind]);

  const [formError, setFormError] = useState(null);
  const [saved, setSaved] = useState(false);
  const { run, busy, error } = useAsyncAction(adminApi.updateQuestion);
  const deleteAction = useAsyncAction(adminApi.deleteQuestion);

  const onDelete = async () => {
    const label = question.kind === 'contest' ? 'contest' : 'question';
    if (!window.confirm(`Delete this ${label}? This can't be undone. Remaining items will be renumbered.`)) return;
    const r = await deleteAction.run(quizId, question.id);
    if (r.ok) onSaved(); // reloads the full quiz (order already renumbered server-side)
  };

  const setPrompt = (lang, value) => setPrompts((m) => ({ ...m, [lang]: value }));
  const setExplanation = (lang, value) => setExplanations((m) => ({ ...m, [lang]: value }));
  const setOptText = (oid, lang, value) =>
    setOptTexts((m) => ({ ...m, [oid]: { ...m[oid], [lang]: value } }));

  const filledLangs = LANGS.filter((l) => (prompts[l.code] || '').trim().length > 0).map((l) => l.code);
  const isContest = question.kind === 'contest';
  const isAudio = question.kind === 'audio';
  const { t: tr } = useT();

  const onSave = async () => {
    setFormError(null);
    setSaved(false);

    let pts = Number(points);
    if (isAudio) {
      pts = 0;
    } else if (!Number.isInteger(pts) || pts < 1 || pts > 1000) {
      setFormError((isContest ? 'Max points' : 'Points') + ' must be a whole number between 1 and 1000.');
      return;
    }

    // Build prompts payload: any language with non-empty text.
    const promptsPayload = {};
    for (const l of LANGS) {
      const v = (prompts[l.code] || '').trim();
      if (v.length > 0) promptsPayload[l.code] = v;
    }
    if (Object.keys(promptsPayload).length === 0) {
      setFormError((isContest || isAudio) ? 'A title is required in at least one language.' : 'A question needs a prompt in at least one language.');
      return;
    }

    // Build explanations payload. Send a language's explanation when it has a
    // value now, or had one before (to allow clearing → empty string).
    const explanationsPayload = {};
    for (const l of LANGS) {
      const now = (explanations[l.code] || '').trim();
      const before = (question.explanations && question.explanations[l.code]) || '';
      if (now.length > 0 || before.length > 0) explanationsPayload[l.code] = now;
    }

    // Audio is unscored — never send points (its stored technical value stays
    // untouched). Contests/questions send points as before.
    const payload = {
      prompts: promptsPayload,
      explanations: explanationsPayload,
    };
    if (isAudio) {
      payload.audioUrl = (audioUrl || '').trim();
      payload.audioGuideId = audioGuideId ? Number(audioGuideId) : null;
    } else {
      payload.points = pts;
    }
    if (!isContest && !isAudio) {
      const optionsPayload = [];
      for (const o of question.options) {
        const texts = {};
        for (const l of LANGS) {
          const v = (optTexts[o.id][l.code] || '').trim();
          if (v.length > 0) texts[l.code] = v;
        }
        if (Object.keys(texts).length > 0) optionsPayload.push({ id: o.id, texts });
      }
      payload.correctOptionId = correctId;
      payload.options = optionsPayload;
    }

    const result = await run(quizId, question.id, payload);
    if (result.ok) {
      setSaved(true);
      onSaved();
    }
  };

  const errorMessage = formError || (error && error.message);

  return (
    <div className="card stack">
      <div className="row row--between">
        <h3>
          <ItemKindBadge kind={question.kind || 'question'} />
          #{question.orderIndex}
        </h3>
        <span className="q-row__points">
          {isAudio ? 'audio' : isContest ? `max ${question.points} pts` : `${question.options.length} options`}
        </span>
      </div>

      {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}
      {saved ? <Alert kind="success">Saved.</Alert> : null}

      {isAudio ? (
        <>
          <div className="field">
            <label className="field__label">{tr('audio_link_guide_label')}</label>
            <select
              className="input"
              value={audioGuideId}
              onChange={(e) => setAudioGuideId(e.target.value)}
              disabled={guides === null}
            >
              <option value="">
                {guides === null ? tr('audio_link_guide_loading') : tr('audio_link_guide_none')}
              </option>
              {(guides || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({(g.languageCoverage || []).map((l) => l.toUpperCase()).join(', ') || tr('audio_link_guide_no_variants')})
                </option>
              ))}
            </select>
            <p className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>
              {tr('audio_link_guide_hint')}
            </p>
            {audioGuideId && guides ? (() => {
              const g = guides.find((x) => String(x.id) === String(audioGuideId));
              if (!g) return null;
              const cov = (g.languageCoverage || []).map((l) => l.toUpperCase());
              return (
                <p className="tiny" style={{ marginTop: 'var(--space-1)' }}>
                  {tr('audio_link_langs_available', { list: cov.length ? cov.join(', ') : tr('audio_link_langs_none_yet') })}
                </p>
              );
            })() : null}
          </div>
          <div className="field">
            <label className="field__label">{tr('audio_link_url_label')}</label>
            <input
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://… .mp3"
              value={audioUrl}
              onChange={(e) => setAudioUrl(e.target.value)}
            />
            <p className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>
              {tr('audio_link_url_hint')}
            </p>
          </div>
        </>
      ) : (
        <div className="field">
          <label className="field__label">{isContest ? 'Max points' : 'Points'}</label>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            inputMode="numeric"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            style={{ maxWidth: '8rem' }}
          />
        </div>
      )}

      <div className="lang-tabs" role="tablist" aria-label="Question languages">
        {LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            role="tab"
            aria-selected={activeLang === l.code}
            className={`lang-tab${activeLang === l.code ? ' lang-tab--active' : ''}${filledLangs.includes(l.code) ? ' lang-tab--filled' : ''}`}
            onClick={() => setActiveLang(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label className="field__label">{(isContest || isAudio) ? 'Title' : 'Prompt'} ({activeLang.toUpperCase()})</label>
        <textarea
          className="textarea"
          rows={2}
          maxLength={2000}
          value={prompts[activeLang]}
          onChange={(e) => setPrompt(activeLang, e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label">
          {(isContest || isAudio) ? 'Description' : 'Explanation / comment'} ({activeLang.toUpperCase()}{(isContest || isAudio) ? '' : ', optional'})
        </label>
        <textarea
          className="textarea"
          rows={2}
          maxLength={2000}
          value={explanations[activeLang]}
          onChange={(e) => setExplanation(activeLang, e.target.value)}
          placeholder={isAudio
            ? 'Shown to teams while the audio plays, e.g. "Listen to audio".'
            : isContest
              ? 'Describe the challenge, e.g. how it is judged.'
              : 'Shown to the host (and after the round) — why this answer is correct.'}
        />
      </div>

      {(!isContest && !isAudio) ? (
      <div>
        <span className="field__label" style={{ marginBottom: 'var(--space-3)' }}>
          Options ({activeLang.toUpperCase()}) — select the correct one (shared across languages)
        </span>
        <div className="stack-tight">
          {question.options.map((o) => (
            <div key={o.id} className="row" style={{ alignItems: 'stretch' }}>
              <label
                className={`checkbox${correctId === o.id ? ' checkbox--selected' : ''}`}
                style={{ flex: '0 0 auto' }}
                title="Mark as correct (applies to all languages)"
              >
                <input
                  type="radio"
                  name={`correct-${question.id}`}
                  checked={correctId === o.id}
                  onChange={() => setCorrectId(o.id)}
                />
              </label>
              <input
                className="input"
                style={{ flex: '1 1 auto' }}
                maxLength={500}
                placeholder={`Option ${o.orderIndex}`}
                value={optTexts[o.id][activeLang]}
                onChange={(e) => setOptText(o.id, activeLang, e.target.value)}
              />
            </div>
          ))}
        </div>
      </div>
      ) : null}

      {deleteAction.error ? <Alert kind="error">{deleteAction.error.message}</Alert> : null}

      <div className="btn-row">
        <button className="btn" onClick={onSave} disabled={busy || deleteAction.busy}>
          {busy ? 'Saving…' : (isAudio ? 'Save audio' : isContest ? 'Save challenge' : 'Save question')}
        </button>
        <button className="btn btn--danger btn--small" onClick={onDelete} disabled={deleteAction.busy || busy}>
          {deleteAction.busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Delete section ---------------- */

function DeleteQuizSection({ quizId, usedInSessions }) {
  const navigate = useNavigate();
  const { run, busy, error } = useAsyncAction(adminApi.deleteQuiz);

  const onDelete = async () => {
    const verb = usedInSessions ? 'archive' : 'permanently delete';
    if (!window.confirm(
      `This will ${verb} the quiz.` +
      (usedInSessions
        ? ' It has been used in a session, so it will be archived (hidden from new sessions) rather than deleted.'
        : ' It has never been used, so it will be permanently removed.') +
      '\n\nContinue?'
    )) return;

    const result = await run(quizId);
    if (result.ok) {
      // result.value = { action: 'deleted' | 'archived', sessionRefs }
      navigate('/admin/quizzes', { replace: true });
    }
  };

  return (
    <section className="card stack">
      <h2 style={{ fontSize: '1rem' }}>Danger zone</h2>
      {error ? <Alert kind="error">{error.message}</Alert> : null}
      <p className="muted small">
        {usedInSessions
          ? 'This quiz has session history. Deleting will archive it (preserving past results) and hide it from new sessions.'
          : 'This quiz has never been used. Deleting will permanently remove it and its questions.'}
      </p>
      <button className="btn btn--danger" onClick={onDelete} disabled={busy}>
        {busy ? 'Working…' : (usedInSessions ? 'Archive quiz' : 'Delete quiz')}
      </button>
    </section>
  );
}

/*
 * Reorder questions. Mobile-first: every row has up/down buttons (the reliable
 * touch path), plus HTML5 drag-and-drop for desktop. Any change is applied
 * optimistically to the local list and persisted via reorderQuestions(); on
 * error we reload from the server to revert.
 */
function QuestionReorder({ quiz, onReordered }) {
  const [order, setOrder] = useState(() => quiz.questions.map((q) => q.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragId, setDragId] = useState(null);

  // Keep local order in sync if the quiz reloads with a new question set.
  useEffect(() => {
    setOrder(quiz.questions.map((q) => q.id));
  }, [quiz.questions]);

  const byId = useMemoQuestions(quiz.questions);

  const persist = async (nextOrder) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.reorderQuestions(quiz.id, nextOrder);
      if (onReordered) await onReordered();
    } catch (err) {
      setError(err);
      // Revert to server truth.
      setOrder(quiz.questions.map((q) => q.id));
    } finally {
      setBusy(false);
    }
  };

  const move = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    const next = order.slice();
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    setOrder(next);
    persist(next);
  };

  const onDrop = (targetId) => {
    if (dragId == null || dragId === targetId) { setDragId(null); return; }
    const next = order.slice();
    const from = next.indexOf(dragId);
    const to = next.indexOf(targetId);
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setDragId(null);
    setOrder(next);
    persist(next);
  };

  return (
    <section className="stack-tight">
      <div className="row row--between">
        <h2 style={{ fontSize: '1rem' }}>Reorder questions</h2>
        {busy ? <span className="tiny muted">Saving…</span> : null}
      </div>
      <p className="tiny muted">Drag a row, or use the arrows. Saved automatically.</p>
      {error ? <Alert kind="error">{error.message}</Alert> : null}
      <ul className="reorder-list">
        {order.map((id, i) => {
          const q = byId.get(id);
          if (!q) return null;
          const label = q.prompts?.en || q.prompts?.sk || q.prompts?.de || `Question ${i + 1}`;
          return (
            <li
              key={id}
              className={`reorder-row${dragId === id ? ' reorder-row--dragging' : ''}`}
              draggable={!busy}
              onDragStart={() => setDragId(id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(id)}
              onDragEnd={() => setDragId(null)}
            >
              <span className="reorder-row__handle" aria-hidden="true">⋮⋮</span>
              <span className="reorder-row__pos">{i + 1}</span>
              <span className="reorder-row__label">
                {q.kind && q.kind !== 'question' ? <ItemKindBadge kind={q.kind} size="sm" /> : null}
                {label}
              </span>
              <span className="reorder-row__btns">
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => move(i, -1)}
                  disabled={busy || i === 0}
                  aria-label="Move up"
                >↑</button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => move(i, 1)}
                  disabled={busy || i === order.length - 1}
                  aria-label="Move down"
                >↓</button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Small helper: a Map from question id → question, memoized on the list.
function useMemoQuestions(questions) {
  return useMemo(() => {
    const m = new Map();
    for (const q of questions) m.set(q.id, q);
    return m;
  }, [questions]);
}
