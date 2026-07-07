import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { AppBar } from '../../components/AppBar.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';
import { LanguageSwitcher } from '../../components/LanguageSwitcher.jsx';
import { useT } from '../../i18n/ui.js';
import { usersApi } from '../../api/client.js';

/*
 * Users management page — Phase 1C-B.
 *
 * super_admin only. Backend already enforces this; the page-level guard
 * here is UX courtesy (redirect to menu if a non-super somehow loads it).
 *
 * Layout: a "Create admin" card on top, then one card per admin. All
 * controls save inline on change — no big Save button — matching the
 * editing pattern used by Rules/Sirups. Self-protection mirrors backend:
 * the row matching the signed-in admin has role + active controls
 * disabled.
 */
export default function UsersPage() {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isSuper = !!admin && admin.role === 'super_admin';

  const [meta, setMeta] = useState(null);    // { roles, permissionKeys, roleDefaults }
  const [list, setList] = useState(null);    // admins[]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const [m, l] = await Promise.all([usersApi.meta(), usersApi.list()]);
      setMeta(m);
      setList(l.admins);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (isSuper) load(); }, [isSuper, load]);

  // Page-level guard: non-super lands here? Send them home.
  useEffect(() => {
    if (admin && !isSuper) navigate('/admin/menu', { replace: true });
  }, [admin, isSuper, navigate]);

  // Update one admin in the list after a successful mutation.
  const upsert = (updated) => {
    setList((cur) => (cur || []).map((a) => (a.id === updated.id ? updated : a)));
  };
  const append = (created) => {
    setList((cur) => [...(cur || []), created]);
  };

  return (
    <div className="page">
      <AppBar
        title={tr('users_title')}
        back
        backTo="/admin/menu"
        right={
          <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} compact />
            <button className="appbar__action" onClick={async () => { await logout(); navigate('/admin/login', { replace: true }); }}>
              {tr('common_sign_out')}
            </button>
          </span>
        }
      />
      <main className="page__main">
        {!isSuper ? (
          // Will redirect via the effect above; render nothing meaningful.
          <p className="muted small">{tr('users_super_only')}</p>
        ) : error ? (
          <Alert kind="error">
            <strong>{tr('users_load_failed')}</strong>
            <div style={{ marginTop: 'var(--space-1)' }}>{error.message}</div>
          </Alert>
        ) : (busy && !list) ? (
          <Spinner label={tr('common_loading')} />
        ) : !list ? (
          <p className="muted small">{tr('common_loading')}</p>
        ) : (
          <div className="stack-lg">
            <CreateCard meta={meta} onCreated={append} tr={tr} />
            <ul className="users-list">
              {list.map((u) => (
                <UserCard
                  key={u.id}
                  user={u}
                  meta={meta}
                  isSelf={u.id === admin.id}
                  onUpdated={upsert}
                  allUsers={list}
                  tr={tr}
                />
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------------- Create card ---------------- */

function CreateCard({ meta, onCreated, tr }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('operator');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!username || password.length < 8) {
      setErr(new Error(tr('users_validation_create')));
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await usersApi.create({ username: username.trim(), password, role });
      onCreated(r.admin);
      setUsername(''); setPassword(''); setRole('operator');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="user-card user-card--create">
      <h2 className="user-card__title">{tr('users_create_title')}</h2>
      <div className="stack-tight">
        <label className="field">
          <span className="field__label">{tr('users_field_username')}</span>
          <input
            className="input"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field__label">{tr('users_field_password')}</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            placeholder={tr('users_password_hint')}
          />
        </label>
        <label className="field">
          <span className="field__label">{tr('users_field_role')}</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {meta && meta.roles.map((r) => (
              <option key={r} value={r}>{tr(`users_role_${r}`)}</option>
            ))}
          </select>
        </label>
      </div>
      {err ? <Alert kind="error" style={{ marginTop: 'var(--space-2)' }}>{err.message}</Alert> : null}
      <div className="row" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)' }}>
        <button className="btn btn--accent btn--small" onClick={submit} disabled={busy}>
          {busy ? tr('users_creating') : tr('users_create_btn')}
        </button>
      </div>
    </section>
  );
}

/* ---------------- User card ---------------- */

function UserCard({ user, meta, isSelf, onUpdated, allUsers, tr }) {
  const [savedHint, setSavedHint] = useState(null);  // 'role' | 'active' | 'permissions' | 'password' | null
  const [err, setErr] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);

  const flash = (key) => {
    setSavedHint(key);
    setTimeout(() => setSavedHint((cur) => (cur === key ? null : cur)), 1800);
  };

  const safe = async (fn, hintKey) => {
    setErr(null);
    try {
      const r = await fn();
      if (r && r.admin) onUpdated(r.admin);
      if (hintKey) flash(hintKey);
    } catch (e) {
      setErr(e);
    }
  };

  // role + active controls disabled for self (mirrors server-side
  // self-protection; backend will 409 anyway, but this avoids the user
  // even trying).
  const lockSelf = isSelf;

  const isSuper = user.role === 'super_admin';
  // For super_admin rows, the effective map is always all-true (backend
  // resolver bypasses the override). Show toggles disabled and on.
  const eff = user.effectivePermissions || {};
  const usingDefaults = user.permissions === null;

  return (
    <li className="user-card">
      <header className="user-card__header">
        <div className="user-card__title-row">
          <span className="user-card__username">{user.username}</span>
          <span className={`role-pill role-pill--${user.role}`}>
            {tr(`users_role_${user.role}`)}
          </span>
          {!user.isActive ? (
            <span className="status-pill status-pill--inactive">{tr('users_inactive')}</span>
          ) : null}
          {isSelf ? <span className="tiny muted">{tr('users_you')}</span> : null}
        </div>
      </header>

      {err ? <Alert kind="error" style={{ marginBottom: 'var(--space-2)' }}>{err.message}</Alert> : null}

      <div className="user-card__controls">
        <label className="field field--inline">
          <span className="field__label">{tr('users_field_role')}</span>
          <select
            className="input"
            value={user.role}
            disabled={lockSelf}
            onChange={(e) => safe(() => usersApi.setRole(user.id, e.target.value), 'role')}
          >
            {meta && meta.roles.map((r) => (
              <option key={r} value={r}>{tr(`users_role_${r}`)}</option>
            ))}
          </select>
          {savedHint === 'role' ? <span className="tiny muted">{tr('users_saved')}</span> : null}
        </label>

        <label className="field field--inline">
          <span className="field__label">{tr('users_field_active')}</span>
          <input
            type="checkbox"
            checked={user.isActive}
            disabled={lockSelf}
            onChange={(e) => safe(() => usersApi.setActive(user.id, e.target.checked), 'active')}
          />
          {savedHint === 'active' ? <span className="tiny muted">{tr('users_saved')}</span> : null}
        </label>
      </div>

      <div className="user-card__perms">
        <div className="user-card__perms-header">
          <strong className="small">{tr('users_permissions')}</strong>
          {isSuper ? (
            <span className="tiny muted">{tr('users_super_all')}</span>
          ) : usingDefaults ? (
            <span className="tiny muted">{tr('users_using_defaults')}</span>
          ) : (
            <span className="tiny muted">{tr('users_custom')}</span>
          )}
        </div>
        <PermissionGrid
          user={user}
          meta={meta}
          eff={eff}
          isSuper={isSuper}
          onChange={(newMap) => safe(() => usersApi.setPermissions(user.id, newMap), 'permissions')}
          tr={tr}
        />
        {!isSuper && !usingDefaults ? (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => safe(() => usersApi.setPermissions(user.id, null), 'permissions')}
            >
              {tr('users_reset_defaults')}
            </button>
            {savedHint === 'permissions' ? <span className="tiny muted" style={{ marginLeft: 'var(--space-2)' }}>{tr('users_saved')}</span> : null}
          </div>
        ) : savedHint === 'permissions' ? (
          <div className="tiny muted" style={{ marginTop: 'var(--space-1)' }}>{tr('users_saved')}</div>
        ) : null}
      </div>

      <div className="user-card__password">
        {!pwOpen ? (
          <button className="btn btn--ghost btn--small" onClick={() => setPwOpen(true)}>
            {tr('users_password_reset')}
          </button>
        ) : (
          <PasswordResetForm
            onCancel={() => setPwOpen(false)}
            onSubmit={async (pw) => {
              await safe(async () => { await usersApi.setPassword(user.id, pw); return null; }, 'password');
              setPwOpen(false);
            }}
            tr={tr}
          />
        )}
        {savedHint === 'password' ? <span className="tiny muted" style={{ marginLeft: 'var(--space-2)' }}>{tr('users_saved')}</span> : null}
      </div>

      <CrewPairingField user={user} allUsers={allUsers} onUpdated={onUpdated} tr={tr} />
    </li>
  );
}

/* ---------------- Crew pairing (manual WP external_id) ---------------- */

function CrewPairingField({ user, allUsers, onUpdated, tr }) {
  const current = user.crewExternalId || '';
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  // Re-sync the input if the stored value changes underneath us (e.g. after
  // a save elsewhere refreshes the list).
  useEffect(() => { setValue(user.crewExternalId || ''); }, [user.crewExternalId]);

  const trimmed = value.trim();
  const dirty = trimmed !== current;

  // Soft warning: another admin already carries this exact id. Pairing two
  // admins to the same crew member is almost certainly a mistake, but we
  // don't hard-block (a legit correction might transiently collide).
  const collidesWith = trimmed
    ? (allUsers || []).filter((a) => a.id !== user.id && (a.crewExternalId || '') === trimmed)
    : [];

  const save = async () => {
    setErr(null); setBusy(true); setSaved(false);
    try {
      const r = await usersApi.setCrewExternalId(user.id, trimmed === '' ? null : trimmed);
      if (r && r.admin) onUpdated(r.admin);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="user-card__crew">
      <label className="field">
        <span className="field__label">{tr('users_crew_external_id')}</span>
        <span className="tiny muted">{tr('users_crew_external_id_help')}</span>
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-1)' }}>
          <input
            className="input"
            type="text"
            value={value}
            placeholder={tr('users_crew_unpaired')}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            style={{ maxWidth: '22rem', fontFamily: 'var(--font-mono, monospace)' }}
          />
          <button
            type="button"
            className="btn btn--small"
            disabled={busy || !dirty}
            onClick={save}
          >
            {busy ? tr('common_loading') : tr('users_crew_save')}
          </button>
          {current ? (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy}
              onClick={() => { setValue(''); }}
              title={tr('users_crew_unpair')}
            >
              {tr('users_crew_unpair')}
            </button>
          ) : null}
          {saved ? <span className="tiny muted">{tr('users_saved')}</span> : null}
        </div>
      </label>
      {!current && !dirty ? (
        <p className="tiny muted">{tr('users_crew_unpaired_note')}</p>
      ) : null}
      {collidesWith.length ? (
        <p className="tiny" style={{ color: '#8a5a00' }}>
          {tr('users_crew_collision', { names: collidesWith.map((a) => a.username).join(', ') })}
        </p>
      ) : null}
      {err ? <Alert kind="error" style={{ marginTop: 'var(--space-1)' }}>{err.message}</Alert> : null}
    </div>
  );
}

/* ---------------- Permission grid ---------------- */

function PermissionGrid({ user, meta, eff, isSuper, onChange, tr }) {
  if (!meta) return null;
  const TOP = ['calendar', 'rides', 'rules', 'sirups', 'audioguides', 'challenges'];
  const SUB = ['challenges.manage_quizzes', 'challenges.create_quiz', 'challenges.session_history'];
  const challengesOn = !!eff.challenges;

  // Build the full override map fresh on every change — what you see is
  // what gets saved.
  const toggle = (key, value) => {
    const next = {};
    for (const k of (meta.permissionKeys || [])) next[k] = !!eff[k];
    next[key] = value;
    onChange(next);
  };

  const row = (key, subOf = null) => {
    const disabled = isSuper || (subOf === 'challenges' && !challengesOn);
    return (
      <label key={key} className={`perm-toggle${subOf ? ' perm-toggle--sub' : ''}${disabled ? ' perm-toggle--disabled' : ''}`}>
        <input
          type="checkbox"
          checked={isSuper ? true : !!eff[key]}
          disabled={disabled}
          onChange={(e) => toggle(key, e.target.checked)}
        />
        <span>{tr(`users_perm_${key.replace(/\./g, '__')}`)}</span>
      </label>
    );
  };

  return (
    <div className="perm-grid">
      {TOP.map((k) => row(k))}
      <div className="perm-sub-header tiny muted">{tr('users_perm_challenges_sub')}</div>
      {SUB.map((k) => row(k, 'challenges'))}
    </div>
  );
}

/* ---------------- Password reset form ---------------- */

function PasswordResetForm({ onCancel, onSubmit, tr }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) { setErr(new Error(tr('users_password_hint'))); return; }
    if (pw !== confirm) { setErr(new Error(tr('users_password_mismatch'))); return; }
    setBusy(true); setErr(null);
    try {
      await onSubmit(pw);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-tight" style={{ marginTop: 'var(--space-2)' }}>
      <label className="field">
        <span className="field__label">{tr('users_new_password')}</span>
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={8} />
      </label>
      <label className="field">
        <span className="field__label">{tr('users_confirm_password')}</span>
        <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} />
      </label>
      {err ? <Alert kind="error">{err.message}</Alert> : null}
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button className="btn btn--accent btn--small" onClick={submit} disabled={busy}>
          {busy ? tr('users_saving') : tr('users_save_password')}
        </button>
        <button className="btn btn--ghost btn--small" onClick={onCancel} disabled={busy}>
          {tr('common_cancel')}
        </button>
      </div>
    </div>
  );
}
