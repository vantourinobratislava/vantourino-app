import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { AppBar } from '../components/AppBar.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { LANGS } from '../i18n/lang.js';
import { useT } from '../i18n/ui.js';
import { modulesApi } from '../api/client.js';

/*
 * Rules page — now persistent.
 *
 * Public visitors (and /rules) see the read-only localized view. Admins see an
 * "Edit" button that switches to a per-language editor (title + body), saved to
 * the backend. The DB stores one row per language (app_content key='rules').
 */
export default function RulesPage({ readOnly = false }) {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isAdmin = !!admin && !readOnly;
  const [editing, setEditing] = useState(false);

  return (
    <div className="page">
      <AppBar
        title={tr('menu_rules')}
        back
        backTo={isAdmin ? '/admin/menu' : '/'}
        right={
          <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} compact />
            {isAdmin ? (
              <button className="appbar__action" onClick={async () => { await logout(); navigate('/admin/login', { replace: true }); }}>
                {tr('common_sign_out')}
              </button>
            ) : null}
          </span>
        }
      />
      <main className="page__main">
        {isAdmin && editing ? (
          <RulesEditor onDone={() => setEditing(false)} />
        ) : (
          <RulesView lang={lang} isAdmin={isAdmin} onEdit={() => setEditing(true)} />
        )}
      </main>
    </div>
  );
}

function RulesView({ lang, isAdmin, onEdit }) {
  const { t: tr } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    modulesApi.getRules(lang)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [lang]);

  return (
    <div className="stack">
      {isAdmin ? (
        <div className="row row--between">
          <span />
          <button className="btn btn--secondary btn--small" onClick={onEdit}>{tr('common_edit')}</button>
        </div>
      ) : null}

      {error ? <Alert kind="error">{error.message}</Alert> : null}
      {!data && !error ? <Spinner label={tr('common_loading')} /> : null}

      {data ? (
        (!data.title && !data.body) ? (
          <p className="muted">{tr('rules_empty')}</p>
        ) : (
          <article className="prose stack">
            {data.title ? <h1>{data.title}</h1> : null}
            {data.body ? <Body text={data.body} /> : null}
          </article>
        )
      ) : null}
    </div>
  );
}

function Body({ text }) {
  // Paragraphs split on blank lines; lines starting with "- " become bullets.
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        const bullets = lines.length > 1 && lines.every((l) => l.startsWith('- '));
        if (bullets) return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul>;
        return <p key={i}>{block}</p>;
      })}
    </>
  );
}

function RulesEditor({ onDone }) {
  const { t: tr } = useT();
  const [activeLang, setActiveLang] = useState('en');
  const [translations, setTranslations] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    modulesApi.getRulesFull()
      .then((d) => { if (!cancelled) { setTranslations(d.translations || {}); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const setField = (l, field, value) => {
    setSaved(false);
    setTranslations((prev) => ({ ...prev, [l]: { ...(prev[l] || {}), [field]: value } }));
  };

  const onSave = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const payload = {};
      for (const l of LANGS) {
        const v = translations[l.code] || {};
        payload[l.code] = { title: (v.title || '').trim() || null, body: v.body != null ? String(v.body) : null };
      }
      const out = await modulesApi.setRules(payload);
      setTranslations(out.translations || {});
      setSaved(true);
    } catch (e) { setError(e); } finally { setSaving(false); }
  };

  if (loading) return <Spinner label={tr('common_loading')} />;

  const cur = translations[activeLang] || {};
  const filled = LANGS.filter((l) => ((translations[l.code] && translations[l.code].title) || '').trim().length > 0).map((l) => l.code);

  return (
    <div className="card stack">
      <div className="row row--between">
        <h2 style={{ fontSize: '1rem', margin: 0 }}>{tr('menu_rules')}</h2>
        <button className="btn btn--ghost btn--small" onClick={onDone}>{tr('common_back')}</button>
      </div>

      {error ? <Alert kind="error">{error.message}</Alert> : null}
      {saved ? <Alert kind="success">{tr('common_saved')}</Alert> : null}

      <div className="lang-tabs" role="tablist" aria-label="Rules languages">
        {LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            role="tab"
            aria-selected={activeLang === l.code}
            className={`lang-tab${activeLang === l.code ? ' lang-tab--active' : ''}${filled.includes(l.code) ? ' lang-tab--filled' : ''}`}
            onClick={() => setActiveLang(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="r-title">{tr('rules_title_label')} ({activeLang.toUpperCase()})</label>
        <input id="r-title" className="input" maxLength={255} value={cur.title || ''} onChange={(e) => setField(activeLang, 'title', e.target.value)} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="r-body">{tr('rules_body_label')} ({activeLang.toUpperCase()})</label>
        <textarea id="r-body" className="textarea" rows={12} maxLength={20000} value={cur.body || ''} onChange={(e) => setField(activeLang, 'body', e.target.value)} placeholder={tr('rules_body_placeholder')} />
        <p className="tiny muted">{tr('rules_body_hint')}</p>
      </div>

      <div className="btn-row">
        <button className="btn btn--secondary" onClick={onDone} disabled={saving}>{tr('common_cancel')}</button>
        <button className="btn" onClick={onSave} disabled={saving}>{saving ? tr('common_saving') : tr('common_save')}</button>
      </div>
    </div>
  );
}
