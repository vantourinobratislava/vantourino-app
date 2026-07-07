import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { AppBar } from '../components/AppBar.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { LANGS } from '../i18n/lang.js';
import { useT } from '../i18n/ui.js';
import { modulesApi } from '../api/client.js';

/*
 * Sirups page — now persistent and manageable.
 *
 * Everyone sees the localized accordion (title → expandable description).
 * Admins additionally get a Manage section: Add new / Edit (per-language tabs) /
 * Delete. Backend stores sirups + per-language translations.
 */
export default function SirupsPage({ readOnly = false }) {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isAdmin = !!admin && !readOnly;

  const [items, setItems] = useState(null); // localized view
  const [full, setFull] = useState(null);   // all-language (admin)
  const [error, setError] = useState(null);

  const loadPublic = useCallback(
    () => modulesApi.listSirups(lang).then((d) => { setItems(d.sirups || []); setError(null); }).catch(setError),
    [lang]
  );
  const loadFull = useCallback(
    () => modulesApi.listSirupsFull().then((d) => { setFull(d.sirups || []); setError(null); }).catch(setError),
    []
  );

  useEffect(() => { loadPublic(); }, [loadPublic]);
  useEffect(() => { if (isAdmin) loadFull(); }, [isAdmin, loadFull]);

  return (
    <div className="page">
      <AppBar
        title={tr('menu_sirups')}
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
        <div className="stack-lg">
          {error ? <Alert kind="error">{error.message}</Alert> : null}

          {items === null ? (
            <Spinner label={tr('common_loading')} />
          ) : items.length === 0 ? (
            <p className="muted">{tr('sirups_empty')}</p>
          ) : (
            <div className="sirups-list">
              {items.map((s) => (
                <details key={s.id} className="sirup-item">
                  <summary className="sirup-item__summary">
                    <span className="sirup-item__title">{s.title}</span>
                    <span className="sirup-item__chev" aria-hidden="true">›</span>
                  </summary>
                  {s.description ? <div className="sirup-item__body">{s.description}</div> : null}
                </details>
              ))}
            </div>
          )}

          {isAdmin ? (
            <ManagePanel items={full} onChanged={async () => { await loadFull(); await loadPublic(); }} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ManagePanel({ items, onChanged }) {
  const { t: tr } = useT();
  const [editingId, setEditingId] = useState(null); // null | 'new' | id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onDelete = async (id) => {
    if (!window.confirm(tr('sirups_delete_confirm'))) return;
    setBusy(true); setError(null);
    try { await modulesApi.deleteSirup(id); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <section className="stack">
      <div className="row row--between">
        <h2 style={{ fontSize: '1rem' }}>{tr('sirups_manage')}</h2>
        <button className="btn btn--accent btn--small" onClick={() => setEditingId('new')} disabled={editingId !== null}>
          + {tr('sirups_add')}
        </button>
      </div>

      {error ? <Alert kind="error">{error.message}</Alert> : null}
      {items === null ? <Spinner label={tr('common_loading')} /> : null}

      {editingId === 'new' ? (
        <EditCard initial={null} onCancel={() => setEditingId(null)} onSaved={async () => { setEditingId(null); await onChanged(); }} />
      ) : null}

      {items && items.length > 0 ? (
        <ul className="manage-list">
          {items.map((s) => {
            const label =
              (s.translations?.en?.title) || (s.translations?.sk?.title) || (s.translations?.de?.title) || `#${s.id}`;
            return (
              <li key={s.id} className="manage-row">
                {editingId === s.id ? (
                  <EditCard initial={s} onCancel={() => setEditingId(null)} onSaved={async () => { setEditingId(null); await onChanged(); }} />
                ) : (
                  <div className="row row--between" style={{ width: '100%', alignItems: 'center' }}>
                    <span className="standing-row__name">{label}</span>
                    <span className="row" style={{ gap: 'var(--space-2)' }}>
                      <button className="btn btn--ghost btn--small" onClick={() => setEditingId(s.id)} disabled={busy}>{tr('common_edit')}</button>
                      <button className="btn btn--ghost btn--small" onClick={() => onDelete(s.id)} disabled={busy}>{tr('common_delete')}</button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function EditCard({ initial, onCancel, onSaved }) {
  const { t: tr } = useT();
  const [activeLang, setActiveLang] = useState('en');
  const [translations, setTranslations] = useState(() => {
    const out = {};
    for (const l of LANGS) {
      const src = initial && initial.translations && initial.translations[l.code];
      out[l.code] = { title: (src && src.title) || '', description: (src && src.description) || '' };
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setField = (l, field, value) =>
    setTranslations((prev) => ({ ...prev, [l]: { ...prev[l], [field]: value } }));

  const onSave = async () => {
    setSaving(true); setError(null);
    try {
      const payload = {};
      for (const l of LANGS) {
        const v = translations[l.code];
        if (v && v.title && v.title.trim().length > 0) {
          payload[l.code] = { title: v.title.trim(), description: v.description || '' };
        }
      }
      if (Object.keys(payload).length === 0) { setError(new Error(tr('sirups_need_title'))); setSaving(false); return; }
      if (initial) await modulesApi.updateSirup(initial.id, payload);
      else await modulesApi.createSirup(payload);
      await onSaved();
    } catch (e) { setError(e); } finally { setSaving(false); }
  };

  const filled = LANGS.filter((l) => (translations[l.code].title || '').trim().length > 0).map((l) => l.code);
  const cur = translations[activeLang];

  return (
    <div className="card stack" style={{ width: '100%' }}>
      {error ? <Alert kind="error">{error.message}</Alert> : null}

      <div className="lang-tabs" role="tablist" aria-label="Sirup languages">
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
        <label className="field__label" htmlFor="s-title">{tr('sirups_title_label')} ({activeLang.toUpperCase()})</label>
        <input id="s-title" className="input" maxLength={255} value={cur.title} onChange={(e) => setField(activeLang, 'title', e.target.value)} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="s-desc">{tr('sirups_desc_label')} ({activeLang.toUpperCase()})</label>
        <textarea id="s-desc" className="textarea" rows={4} maxLength={5000} value={cur.description} onChange={(e) => setField(activeLang, 'description', e.target.value)} />
      </div>

      <div className="btn-row">
        <button className="btn btn--secondary" onClick={onCancel} disabled={saving}>{tr('common_cancel')}</button>
        <button className="btn" onClick={onSave} disabled={saving}>{saving ? tr('common_saving') : tr('common_save')}</button>
      </div>
    </div>
  );
}
