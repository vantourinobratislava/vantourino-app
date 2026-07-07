import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { AppBar } from '../components/AppBar.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { useT } from '../i18n/ui.js';
import { audioApi, AUDIO_LANGS } from '../api/client.js';

/*
 * Audioguides library (Phase B2.1).
 *
 * Two sections for admins:
 *   1. Guides — one row per conceptual guide; each guide can hold up to one
 *      recording per supported language (EN/DE/SK/IT/ES/FR). Expand a guide to
 *      attach an existing ungrouped recording to a language slot, detach a
 *      variant, rename, or delete the guide.
 *   2. Ungrouped recordings — the B1 list of recordings not attached to any
 *      guide. Upload still lands here; admins then attach to a guide.
 *
 * Phase A AUDIO items still use raw URLs; B2.2 will let those items pick a
 * guide instead.
 */
export default function AudioguidesPage({ readOnly = false }) {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isAdmin = !!admin && !readOnly;

  const [recordings, setRecordings] = useState(null);
  const [guides, setGuides] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([audioApi.list(), audioApi.listGuides()]);
      setRecordings(r.recordings || []);
      setGuides(g.guides || []);
      setError(null);
    } catch (e) { setError(e); }
  }, []);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const ungrouped = (recordings || []).filter((r) => !r.guideId);

  return (
    <div className="page">
      <AppBar
        title={tr('menu_audioguides')}
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
        {!isAdmin ? (
          <div className="coming-soon">
            <div className="coming-soon__emoji" aria-hidden="true">🎧</div>
            <p className="muted">{tr('audioguides_public_note')}</p>
          </div>
        ) : (
          <div className="stack-lg">
            {error ? <Alert kind="error">{error.message}</Alert> : null}

            <GuidesSection
              guides={guides}
              ungrouped={ungrouped}
              onChanged={load}
            />

            <RecordingsSection
              recordings={recordings}
              onChanged={load}
            />
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------------- Guides ---------------- */
function GuidesSection({ guides, ungrouped, onChanged }) {
  const { t: tr } = useT();
  const [creating, setCreating] = useState(false);

  return (
    <section className="stack">
      <div className="row row--between">
        <h2 style={{ fontSize: '1rem', margin: 0 }}>{tr('audio_guides_title')}</h2>
        <button className="btn btn--accent btn--small" onClick={() => setCreating(true)} disabled={creating}>
          + {tr('audio_guides_new')}
        </button>
      </div>

      {creating ? (
        <CreateGuideCard onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await onChanged(); }} />
      ) : null}

      {guides === null ? <Spinner label={tr('common_loading')} /> : null}
      {guides && guides.length === 0 && !creating ? (
        <p className="muted">{tr('audio_guides_empty')}</p>
      ) : null}

      {guides && guides.length > 0 ? (
        <ul className="audio-list">
          {guides.map((g) => (
            <GuideRow key={g.id} guide={g} ungrouped={ungrouped} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CreateGuideCard({ onCancel, onSaved }) {
  const { t: tr } = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onSave = async () => {
    const t = title.trim();
    if (!t) { setError(new Error(tr('audio_guides_need_title'))); return; }
    setBusy(true); setError(null);
    try {
      await audioApi.createGuide({ title: t, description: description.trim() || null });
      await onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="card stack">
      {error ? <Alert kind="error">{error.message}</Alert> : null}
      <div className="field">
        <label className="field__label">{tr('audio_guides_title_label')}</label>
        <input className="input" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">{tr('audio_guides_desc_label')}</label>
        <textarea className="textarea" rows={2} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="btn-row">
        <button className="btn btn--secondary" onClick={onCancel} disabled={busy}>{tr('common_cancel')}</button>
        <button className="btn" onClick={onSave} disabled={busy}>{busy ? tr('common_saving') : tr('common_save')}</button>
      </div>
    </div>
  );
}

function GuideRow({ guide, ungrouped, onChanged }) {
  const { t: tr } = useT();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onDelete = async () => {
    if (!window.confirm(tr('audio_guides_delete_confirm'))) return;
    setBusy(true); setError(null);
    try { await audioApi.removeGuide(guide.id); await onChanged(); }
    catch (e) { setError(e); setBusy(false); }
  };

  const onAttach = async (recordingId, lang) => {
    setBusy(true); setError(null);
    try { await audioApi.attach(recordingId, { guideId: guide.id, lang }); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  const onDetach = async (recordingId) => {
    setBusy(true); setError(null);
    try { await audioApi.detach(recordingId); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  const variantByLang = {};
  for (const v of guide.variants) if (v.lang) variantByLang[v.lang] = v;

  return (
    <li className="audio-item">
      <details className="audio-item__details">
        <summary className="audio-item__summary">
          <span className="audio-item__title" title={guide.title}>{guide.title}</span>
          <span className="audio-item__dur audio-coverage">
            {AUDIO_LANGS.map((l) => {
              const v = variantByLang[l.code];
              const broken = v && v.fileStatus === 'missing';
              const cls = !v
                ? 'coverage-chip'
                : broken
                  ? 'coverage-chip coverage-chip--on coverage-chip--broken'
                  : 'coverage-chip coverage-chip--on';
              const titleAttr = !v ? l.label : broken ? `${l.label} — ${tr('audio_status_missing')}` : l.label;
              return (
                <span key={l.code} className={cls} title={titleAttr}>
                  {l.label}{broken ? ' ⚠' : ''}
                </span>
              );
            })}
          </span>
          <span className="audio-item__chev" aria-hidden="true">›</span>
        </summary>
        <div className="audio-item__body stack">
          {error ? <Alert kind="error">{error.message}</Alert> : null}
          {guide.description ? <p className="muted small">{guide.description}</p> : null}

          {editing ? (
            <EditGuideForm
              guide={guide}
              onCancel={() => setEditing(false)}
              onSaved={async () => { setEditing(false); await onChanged(); }}
            />
          ) : (
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button className="btn btn--ghost btn--small" onClick={() => setEditing(true)} disabled={busy}>{tr('common_edit')}</button>
              <button className="btn btn--ghost btn--small" onClick={onDelete} disabled={busy}>{tr('common_delete')}</button>
            </div>
          )}

          <div className="stack">
            <h3 style={{ fontSize: '0.9rem', margin: 0 }}>{tr('audio_guides_variants')}</h3>
            <ul className="variant-list">
              {AUDIO_LANGS.map((l) => {
                const v = variantByLang[l.code];
                return (
                  <li key={l.code} className="variant-row">
                    <span className="variant-row__lang">{l.label}</span>
                    {v ? (
                      <>
                        <span className="variant-row__title" title={v.title}>
                          {v.title}
                          {v.fileStatus === 'missing'
                            ? <span className="status-pill status-pill--broken" title={tr('audio_status_missing')}>{tr('audio_status_missing_short')}</span>
                            : null}
                        </span>
                        <span className="variant-row__dur">{formatDuration(v.durationSeconds)}</span>
                        <button className="btn btn--ghost btn--small" onClick={() => onDetach(v.id)} disabled={busy}>
                          {tr('audio_guides_detach')}
                        </button>
                      </>
                    ) : (
                      <AttachPicker
                        ungrouped={ungrouped}
                        onPick={(rid) => onAttach(rid, l.code)}
                        disabled={busy}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </details>
    </li>
  );
}

function EditGuideForm({ guide, onCancel, onSaved }) {
  const { t: tr } = useT();
  const [title, setTitle] = useState(guide.title);
  const [description, setDescription] = useState(guide.description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onSave = async () => {
    const t = title.trim();
    if (!t) { setError(new Error(tr('audio_guides_need_title'))); return; }
    setBusy(true); setError(null);
    try {
      await audioApi.renameGuide(guide.id, { title: t, description: description.trim() || null });
      await onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="stack-tight">
      {error ? <Alert kind="error">{error.message}</Alert> : null}
      <input className="input" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} aria-label={tr('audio_guides_title_label')} />
      <textarea className="textarea" rows={2} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('audio_guides_desc_label')} />
      <div className="btn-row">
        <button className="btn btn--secondary btn--small" onClick={onCancel} disabled={busy}>{tr('common_cancel')}</button>
        <button className="btn btn--small" onClick={onSave} disabled={busy}>{busy ? tr('common_saving') : tr('common_save')}</button>
      </div>
    </div>
  );
}

function AttachPicker({ ungrouped, onPick, disabled }) {
  const { t: tr } = useT();
  if (!ungrouped || ungrouped.length === 0) {
    return <span className="muted small">{tr('audio_guides_no_ungrouped')}</span>;
  }
  return (
    <select
      className="input"
      defaultValue=""
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v) onPick(Number(v));
        e.target.value = '';
      }}
      style={{ maxWidth: '14rem' }}
    >
      <option value="">{tr('audio_guides_attach_pick')}</option>
      {ungrouped.map((r) => (
        <option key={r.id} value={r.id}>{r.title} ({formatDuration(r.durationSeconds)})</option>
      ))}
    </select>
  );
}

/* ---------------- Recordings (B1, with "ungrouped" lens) ---------------- */
function RecordingsSection({ recordings, onChanged }) {
  const { t: tr } = useT();
  const [brokenOnly, setBrokenOnly] = useState(false);
  const list = recordings || [];
  const brokenCount = list.filter((r) => r.fileStatus === 'missing').length;
  const visible = brokenOnly ? list.filter((r) => r.fileStatus === 'missing') : list;

  return (
    <section className="stack">
      <div className="row row--between" style={{ alignItems: 'center' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>{tr('audio_lib_recordings')}</h2>
        {brokenCount > 0 ? (
          <label className="row" style={{ gap: 'var(--space-1)', alignItems: 'center', fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={brokenOnly}
              onChange={(e) => setBrokenOnly(e.target.checked)}
            />
            {tr('audio_lib_broken_filter')} ({brokenCount})
          </label>
        ) : null}
      </div>
      <Uploader onUploaded={onChanged} />
      {recordings === null ? (
        <Spinner label={tr('common_loading')} />
      ) : list.length === 0 ? (
        <p className="muted">{tr('audio_lib_empty')}</p>
      ) : visible.length === 0 ? (
        <p className="muted">{tr('audio_lib_no_broken')}</p>
      ) : (
        <ul className="audio-list">
          {visible.map((it) => (
            <RecordingRow key={it.id} item={it} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Uploader({ onUploaded }) {
  const { t: tr } = useT();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);

  const onPick = () => inputRef.current && inputRef.current.click();

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy(true); setError(null); setProgress({ done: 0, total: files.length });
    try {
      let done = 0;
      for (const f of files) {
        try { await audioApi.upload([f]); }
        catch (err) { setError(err); }
        done += 1; setProgress({ done, total: files.length });
      }
      await onUploaded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="card stack">
      <div className="row row--between" style={{ alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>{tr('audio_lib_upload_title')}</span>
        <button className="btn btn--accent btn--small" onClick={onPick} disabled={busy}>
          {busy
            ? (progress ? tr('audio_lib_uploading_n', { done: progress.done, total: progress.total }) : tr('audio_lib_uploading'))
            : tr('audio_lib_choose')}
        </button>
      </div>
      <p className="tiny muted">{tr('audio_lib_upload_hint')}</p>
      {error ? <Alert kind="error">{error.message}</Alert> : null}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.wav,.flac,.webm"
        multiple
        style={{ display: 'none' }}
        onChange={onFiles}
      />
    </div>
  );
}

function RecordingRow({ item, onChanged }) {
  const { t: tr } = useT();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const replaceInputRef = useRef(null);

  const broken = item.fileStatus === 'missing';

  const onSave = async () => {
    const t = (title || '').trim();
    if (t.length === 0) { setError(new Error(tr('audio_lib_need_title'))); return; }
    setBusy(true); setError(null);
    try { await audioApi.rename(item.id, t); setEditing(false); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!window.confirm(tr('audio_lib_delete_confirm'))) return;
    setBusy(true); setError(null);
    try { await audioApi.remove(item.id); await onChanged(); }
    catch (e) { setError(e); setBusy(false); }
  };

  const onDetach = async () => {
    setBusy(true); setError(null);
    try { await audioApi.detach(item.id); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  const pickReplaceFile = () => replaceInputRef.current && replaceInputRef.current.click();

  const onReplaceFile = async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    setBusy(true); setError(null);
    try { await audioApi.replaceFile(item.id, f); await onChanged(); }
    catch (err) { setError(err); }
    finally {
      setBusy(false);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    }
  };

  return (
    <li className={`audio-item${broken ? ' audio-item--broken' : ''}`}>
      <details className="audio-item__details">
        <summary className="audio-item__summary">
          <span className="audio-item__title" title={item.title}>
            {item.title}
            {broken
              ? <span className="status-pill status-pill--broken" style={{ marginLeft: 'var(--space-2)' }} title={tr('audio_status_missing')}>{tr('audio_status_missing_short')}</span>
              : null}
            {item.lang ? <span className="lang-pill" style={{ marginLeft: 'var(--space-2)' }}>{item.lang.toUpperCase()}</span> : null}
          </span>
          <span className="audio-item__dur">{formatDuration(item.durationSeconds)}</span>
          <span className="audio-item__chev" aria-hidden="true">›</span>
        </summary>
        <div className="audio-item__body stack">
          {error ? <Alert kind="error">{error.message}</Alert> : null}

          {broken ? (
            <Alert kind="warn">{tr('audio_lib_broken_file_alert')}</Alert>
          ) : (
            <audio controls preload="none" src={audioApi.streamUrl(item.id)} style={{ width: '100%' }}>
              {tr('audio_unsupported')}
            </audio>
          )}

          {item.guideId ? (
            <p className="tiny muted">{tr('audio_lib_attached_note')}</p>
          ) : null}

          {editing ? (
            <div className="stack-tight">
              <input
                className="input"
                value={title}
                maxLength={255}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={tr('audio_lib_title_label')}
              />
              <div className="btn-row">
                <button className="btn btn--secondary btn--small" onClick={() => { setEditing(false); setTitle(item.title); setError(null); }} disabled={busy}>
                  {tr('common_cancel')}
                </button>
                <button className="btn btn--small" onClick={onSave} disabled={busy}>
                  {busy ? tr('common_saving') : tr('common_save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button className="btn btn--ghost btn--small" onClick={() => setEditing(true)} disabled={busy}>{tr('common_edit')}</button>
              <button
                className={`btn btn--small ${broken ? 'btn--accent' : 'btn--ghost'}`}
                onClick={pickReplaceFile}
                disabled={busy}
                title={tr('audio_lib_replace')}
              >
                {busy ? tr('audio_lib_replacing') : tr('audio_lib_replace')}
              </button>
              {item.guideId ? (
                <button className="btn btn--ghost btn--small" onClick={onDetach} disabled={busy}>{tr('audio_guides_detach')}</button>
              ) : null}
              <button className="btn btn--ghost btn--small" onClick={onDelete} disabled={busy}>{tr('common_delete')}</button>
              <input
                ref={replaceInputRef}
                type="file"
                accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.wav,.flac,.webm"
                style={{ display: 'none' }}
                onChange={onReplaceFile}
              />
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
