import { useState, useEffect } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { adminApi, audioApi, AUDIO_LANGS } from '../../api/client.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert } from '../../components/ui.jsx';
import { ItemKindBadge } from '../../components/ItemKindBadge.jsx';
import { LANGS } from '../../i18n/lang.js';
import { useT } from '../../i18n/ui.js';

/*
 * Multilingual question authoring.
 *
 * The STRUCTURE is language-neutral: number of options and which one is
 * correct (correctIndex). Each language fills in the prompt and the option
 * texts in the SAME order. The backend stores correctness by index, so all
 * languages share the correct answer.
 *
 * The admin works one language tab at a time but the option count and the
 * "correct" radio live outside the tabs (they're shared).
 */
export default function QuizQuestions() {
  const { quizId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [quiz] = useState(() => (location.state && location.state.quiz) || null);
  const justCreated = !!(location.state && location.state.justCreated);

  const [questions, setQuestions] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [activeLang, setActiveLang] = useState('en');
  const [formError, setFormError] = useState(null);
  const addAction = useAsyncAction(adminApi.addQuestion);
  const { t: tr } = useT();

  // Load Audioguides library guides for the AUDIO item picker.
  const [guides, setGuides] = useState(null);
  useEffect(() => {
    let cancelled = false;
    audioApi.listGuides()
      .then((d) => { if (!cancelled) setGuides(d.guides || []); })
      .catch(() => { if (!cancelled) setGuides([]); }); // soft-fail; URL still works
    return () => { cancelled = true; };
  }, []);

  const optionCount = draft.optionCount;

  const setPrompt = (lang, value) =>
    setDraft((d) => ({ ...d, prompts: { ...d.prompts, [lang]: value } }));

  const setExplanation = (lang, value) =>
    setDraft((d) => ({ ...d, explanations: { ...d.explanations, [lang]: value } }));

  const setOptionText = (lang, idx, value) =>
    setDraft((d) => {
      const arr = (d.options[lang] || makeRow(optionCount)).slice();
      arr[idx] = value;
      return { ...d, options: { ...d.options, [lang]: arr } };
    });

  const addOption = () => setDraft((d) => {
    if (d.optionCount >= 10) return d;
    const options = {};
    for (const l of LANGS) options[l.code] = (d.options[l.code] || makeRow(d.optionCount)).concat('');
    return { ...d, optionCount: d.optionCount + 1, options };
  });

  const removeOption = (idx) => setDraft((d) => {
    if (d.optionCount <= 2) return d;
    const options = {};
    for (const l of LANGS) options[l.code] = (d.options[l.code] || makeRow(d.optionCount)).filter((_, i) => i !== idx);
    let correctIndex = d.correctIndex;
    if (idx === correctIndex) correctIndex = 0;
    else if (idx < correctIndex) correctIndex -= 1;
    return { ...d, optionCount: d.optionCount - 1, options, correctIndex };
  });

  const filledLangs = LANGS
    .filter((l) => (draft.prompts[l.code] || '').trim().length > 0)
    .map((l) => l.code);

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);

    const isContest = draft.kind === 'contest';
    const isAudio = draft.kind === 'audio';
    const translations = {};

    if (isContest || isAudio) {
      // Contest/Audio: title required per filled language; description optional;
      // no options, no correct answer.
      for (const l of LANGS) {
        const prompt = (draft.prompts[l.code] || '').trim();
        if (prompt.length === 0) continue; // language left blank — skip
        translations[l.code] = { prompt };
        const description = (draft.explanations[l.code] || '').trim();
        if (description.length > 0) translations[l.code].explanation = description;
      }
      if (Object.keys(translations).length === 0) {
        setFormError(isAudio
          ? 'Fill in an audio title in at least one language.'
          : 'Fill in a challenge title in at least one language.');
        return;
      }
    } else {
      // Question: build translations only for languages that have a non-empty
      // prompt AND all option texts filled. Partially-filled languages are
      // rejected with a clear message.
      for (const l of LANGS) {
        const prompt = (draft.prompts[l.code] || '').trim();
        const opts = (draft.options[l.code] || makeRow(optionCount)).map((t) => (t || '').trim());
        const anyFilled = prompt.length > 0 || opts.some((t) => t.length > 0);
        if (!anyFilled) continue;
        if (prompt.length === 0 || opts.some((t) => t.length === 0)) {
          setFormError(`${l.label}: fill in the prompt and all ${optionCount} options, or leave the whole language blank.`);
          return;
        }
        translations[l.code] = { prompt, options: opts };
        const explanation = (draft.explanations[l.code] || '').trim();
        if (explanation.length > 0) translations[l.code].explanation = explanation;
      }
      if (Object.keys(translations).length === 0) {
        setFormError('Fill in at least one language (prompt + all options).');
        return;
      }
    }

    let pts = Number(draft.points);
    if (isAudio) {
      pts = 0; // audio is unscored
    } else if (!Number.isInteger(pts) || pts < 1 || pts > 1000) {
      setFormError(isContest
        ? 'Max points must be a whole number between 1 and 1000.'
        : 'Points must be a whole number between 1 and 1000.');
      return;
    }

    const payload = isAudio
      ? {
          kind: 'audio',
          translations,
          audioUrl: (draft.audioUrl || '').trim(),
          audioGuideId: draft.audioGuideId ? Number(draft.audioGuideId) : null,
        }
      : isContest
        ? { kind: 'contest', points: pts, translations }
        : { points: pts, correctIndex: draft.correctIndex, translations };

    const result = await addAction.run(quizId, payload);
    if (result.ok) {
      setQuestions((qs) => [...qs, {
        id: result.value.question.id,
        orderIndex: result.value.question.orderIndex,
        prompt: result.value.question.prompt,
        points: result.value.question.points,
        kind: result.value.question.kind || 'question',
        languages: result.value.languages,
      }]);
      setDraft(emptyDraft());
      setActiveLang('en');
    }
  };

  const errorMessage = formError || (addAction.error && addAction.error.message);
  const isContest = draft.kind === 'contest';
  const isAudio = draft.kind === 'audio';
  const curPrompt = draft.prompts[activeLang] || '';
  const curExplanation = draft.explanations[activeLang] || '';
  const curOptions = draft.options[activeLang] || makeRow(optionCount);

  return (
    <div className="page">
      <AppBar title="Quiz questions" back backTo="/admin" />
      <main className="page__main">
        <div className="stack-lg">
          <div>
            <h1>{quiz ? quiz.title : `Quiz #${quizId}`}</h1>
            {justCreated ? (
              <p className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                Quiz created. Add at least one question, then start a session.
              </p>
            ) : null}
          </div>

          {questions.length > 0 ? (
            <section className="stack-tight">
              <h2 style={{ fontSize: '1rem' }}>Added this session</h2>
              {questions.map((q) => (
                <div className="q-row" key={q.id}>
                  <span className="q-row__index">{q.orderIndex}</span>
                  <span className="q-row__prompt">
                    {q.kind && q.kind !== 'question' ? <ItemKindBadge kind={q.kind} size="sm" /> : null}
                    {q.prompt}
                  </span>
                  <span className="q-row__points">{(q.languages || []).map((c) => c.toUpperCase()).join('/')} · {q.points} pts</span>
                </div>
              ))}
              <p className="tiny muted">List resets if you refresh — the server has the questions saved.</p>
            </section>
          ) : null}

          <form onSubmit={onSubmit} className="card stack">
            <h2>{isAudio ? 'Add audio' : isContest ? 'Add challenge' : 'Add question'}</h2>
            {errorMessage ? <Alert kind="error">{errorMessage}</Alert> : null}

            {/* Item kind selector */}
            <div className="field">
              <span className="field__label" style={{ marginBottom: 'var(--space-2)' }}>Item type</span>
              <div className="kind-toggle" role="group" aria-label="Item type">
                <button
                  type="button"
                  className={`kind-toggle__btn${draft.kind === 'question' ? ' kind-toggle__btn--active' : ''}`}
                  aria-pressed={draft.kind === 'question'}
                  onClick={() => setDraft((d) => ({ ...d, kind: 'question' }))}
                >
                  Question
                </button>
                <button
                  type="button"
                  className={`kind-toggle__btn${draft.kind === 'contest' ? ' kind-toggle__btn--active' : ''}`}
                  aria-pressed={draft.kind === 'contest'}
                  onClick={() => setDraft((d) => ({ ...d, kind: 'contest' }))}
                >
                  Challenge
                </button>
                <button
                  type="button"
                  className={`kind-toggle__btn${draft.kind === 'audio' ? ' kind-toggle__btn--active' : ''}`}
                  aria-pressed={draft.kind === 'audio'}
                  onClick={() => setDraft((d) => ({ ...d, kind: 'audio' }))}
                >
                  Audio
                </button>
              </div>
              <p className="tiny muted" style={{ marginTop: 'var(--space-2)' }}>
                {isAudio
                  ? 'An audio item plays a recording with a title + description. No options, no scoring, no timer.'
                  : isContest
                    ? 'A challenge has a title + description and is scored manually by the host — no options, no correct answer.'
                    : 'A normal question with answer options and one correct answer.'}
              </p>
            </div>

            {/* Audio guide + URL — audio items only */}
            {isAudio ? (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="audioGuide">{tr('audio_link_guide_label')}</label>
                  <select
                    id="audioGuide"
                    className="input"
                    value={draft.audioGuideId || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, audioGuideId: e.target.value }))}
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
                  {draft.audioGuideId && guides ? (() => {
                    const g = guides.find((x) => String(x.id) === String(draft.audioGuideId));
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
                  <label className="field__label" htmlFor="audioUrl">{tr('audio_link_url_label')}</label>
                  <input
                    id="audioUrl"
                    className="input"
                    type="url"
                    inputMode="url"
                    placeholder="https://… .mp3"
                    value={draft.audioUrl}
                    onChange={(e) => setDraft((d) => ({ ...d, audioUrl: e.target.value }))}
                  />
                  <p className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>
                    {tr('audio_link_url_hint')}
                  </p>
                  {looksNonDirectAudioUrl(draft.audioUrl) ? (
                    <p className="tiny" style={{ marginTop: 'var(--space-1)', color: 'var(--color-accent-dk, #c2570b)' }}>
                      {tr('audio_link_url_warn_nondirect')}
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* Shared (language-neutral) controls — points: not for audio */}
            {!isAudio ? (
            <div className="field">
              <label className="field__label" htmlFor="points">{isContest ? 'Max points' : 'Points'}</label>
              <input
                id="points"
                className="input"
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
                value={draft.points}
                onChange={(e) => setDraft((d) => ({ ...d, points: e.target.value }))}
                style={{ maxWidth: '8rem' }}
              />
            </div>
            ) : null}

            {/* Language tabs */}
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
              <label className="field__label" htmlFor="prompt">
                {(isContest || isAudio) ? 'Title' : 'Prompt'} ({activeLang.toUpperCase()})
              </label>
              <textarea
                id="prompt"
                className="textarea"
                rows={2}
                maxLength={2000}
                value={curPrompt}
                onChange={(e) => setPrompt(activeLang, e.target.value)}
                placeholder={activeLang === 'en'
                  ? (isAudio ? 'e.g. Story of the Old Town' : isContest ? 'e.g. Best team costume' : 'e.g. Which river runs through Bratislava?')
                  : ''}
              />
            </div>

            {draft.kind === 'question' ? (
            <div>
              <span className="field__label" style={{ marginBottom: 'var(--space-3)' }}>
                Options ({activeLang.toUpperCase()}) — select the radio to mark the correct one (shared across languages)
              </span>
              <div className="stack-tight">
                {Array.from({ length: optionCount }).map((_, i) => (
                  <div key={i} className="row" style={{ alignItems: 'stretch' }}>
                    <label
                      className={`checkbox${draft.correctIndex === i ? ' checkbox--selected' : ''}`}
                      style={{ flex: '0 0 auto' }}
                      title="Mark as correct (applies to all languages)"
                    >
                      <input
                        type="radio"
                        name="correct-option"
                        checked={draft.correctIndex === i}
                        onChange={() => setDraft((d) => ({ ...d, correctIndex: i }))}
                      />
                    </label>
                    <input
                      className="input"
                      style={{ flex: '1 1 auto' }}
                      placeholder={`Option ${i + 1}`}
                      maxLength={500}
                      value={curOptions[i] || ''}
                      onChange={(e) => setOptionText(activeLang, i, e.target.value)}
                    />
                    {optionCount > 2 ? (
                      <button type="button" className="btn btn--ghost btn--small"
                              onClick={() => removeOption(i)} aria-label={`Remove option ${i + 1}`}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {optionCount < 10 ? (
                <button type="button" className="btn btn--secondary btn--small"
                        onClick={addOption} style={{ marginTop: 'var(--space-3)' }}>
                  + Add another option
                </button>
              ) : null}
            </div>
            ) : null}

            <div className="field">
              <label className="field__label" htmlFor="explanation">
                {(isContest || isAudio) ? 'Description' : 'Explanation / comment'} ({activeLang.toUpperCase()}{(isContest || isAudio) ? '' : ', optional'})
              </label>
              <textarea
                id="explanation"
                className="textarea"
                rows={2}
                maxLength={2000}
                value={curExplanation}
                onChange={(e) => setExplanation(activeLang, e.target.value)}
                placeholder={activeLang === 'en'
                  ? (isAudio ? 'Shown to teams while the audio plays, e.g. "Listen to audio".' : isContest ? 'Describe the challenge, e.g. how it is judged.' : 'Shown after the question is finished, e.g. why this answer is correct.')
                  : ''}
              />
            </div>

            <p className="tiny muted">
              Filled languages: {filledLangs.length ? filledLangs.map((c) => c.toUpperCase()).join(', ') : 'none yet'}.
              Leave a language blank to skip it; teams will see a filled language instead.
            </p>

            <button type="submit" className="btn" disabled={addAction.busy}>
              {addAction.busy ? 'Saving…' : (isAudio ? 'Save audio' : isContest ? 'Save challenge' : 'Save question')}
            </button>
          </form>

          <div className="btn-row">
            <button
              className="btn btn--accent"
              disabled={questions.length === 0}
              onClick={() => navigate('/admin/sessions/new', { state: { quizId, quizTitle: quiz && quiz.title } })}
            >
              Start a session for this quiz
            </button>
            <Link to="/admin" className="btn btn--secondary" style={{ display: 'inline-flex' }}>
              Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

function makeRow(n) { return Array.from({ length: n }, () => ''); }

// Soft check (non-blocking): flag URLs that are clearly streaming-site pages
// rather than a direct audio file. Phase A plays via <audio src>, which needs a
// direct file URL. We only warn — saving is still allowed.
function looksNonDirectAudioUrl(url) {
  const u = (url || '').trim();
  if (u.length === 0) return false;
  if (/youtube\.com|youtu\.be|vimeo\.com|spotify\.com|soundcloud\.com/i.test(u)) return true;
  // Has an http(s) URL but no audio-like file extension → likely a page link.
  if (/^https?:\/\//i.test(u) && !/\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)(\?|#|$)/i.test(u)) return true;
  return false;
}

function emptyDraft() {
  return {
    kind: 'question',
    points: '10',
    optionCount: 2,
    correctIndex: 0,
    audioUrl: '',
    audioGuideId: '',
    prompts: { en: '', sk: '', de: '' },
    explanations: { en: '', sk: '', de: '' },
    options: { en: ['', ''], sk: ['', ''], de: ['', ''] },
  };
}
