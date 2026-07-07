import { Link, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../../auth/AdminAuth.jsx';
import { AppBar } from '../../components/AppBar.jsx';
import { LanguageSwitcher } from '../../components/LanguageSwitcher.jsx';
import { useT } from '../../i18n/ui.js';

/*
 * Top-level admin menu — the new entry point after sign-in.
 *
 * Each tile leads to its own module. "Challenges" is the existing quiz/session
 * dashboard (kept at /admin so all bookmarks still work). Other tiles point to
 * the new modules. Rides and Audioguides ship as placeholders until their own
 * phases land.
 */
export default function MainMenu() {
  const { admin, logout, can } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();
  const isSuper = !!admin && admin.role === 'super_admin';

  const onLogout = async () => {
    await logout();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="page">
      <AppBar
        title={tr('menu_title')}
        right={
          <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <LanguageSwitcher lang={lang} onChange={setLang} compact />
            <button className="appbar__action" onClick={onLogout}>{tr('common_sign_out')}</button>
          </span>
        }
      />
      <main className="page__main">
        <div className="stack-lg">
          <div className="module-grid">
            {can('calendar') ? (
              <ModuleTile to="/admin/calendar" emoji="📅" label={tr('menu_calendar')} sub={tr('menu_calendar_sub')} />
            ) : null}
            {can('rides') ? (
              <ModuleTile to="/admin/rides" emoji="🚲" label={tr('menu_rides')} sub={tr('menu_rides_sub')} />
            ) : null}
            {can('rules') ? (
              <ModuleTile to="/admin/rules" emoji="📜" label={tr('menu_rules')} sub={tr('menu_rules_sub')} />
            ) : null}
            {can('sirups') ? (
              <ModuleTile to="/admin/sirups" emoji="🍯" label={tr('menu_sirups')} sub={tr('menu_sirups_sub')} />
            ) : null}
            {can('audioguides') ? (
              <ModuleTile to="/admin/audioguides" emoji="🎧" label={tr('menu_audioguides')} sub={tr('menu_audioguides_sub')} />
            ) : null}
            {can('challenges') ? (
              <ModuleTile to="/admin" emoji="🏆" label={tr('menu_challenges')} sub={tr('menu_challenges_sub')} />
            ) : null}
            {/* Users tile: super_admin only (backend also enforces). */}
            {isSuper ? (
              <ModuleTile to="/admin/users" emoji="👥" label={tr('menu_users')} sub={tr('menu_users_sub')} />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function ModuleTile({ to, emoji, label, sub, disabled }) {
  if (disabled) {
    return (
      <div className="module-tile module-tile--disabled" aria-disabled="true">
        <div className="module-tile__emoji" aria-hidden="true">{emoji}</div>
        <div className="module-tile__label">{label}</div>
        {sub ? <div className="module-tile__sub">{sub}</div> : null}
        <span className="module-tile__soon">soon</span>
      </div>
    );
  }
  return (
    <Link to={to} className="module-tile">
      <div className="module-tile__emoji" aria-hidden="true">{emoji}</div>
      <div className="module-tile__label">{label}</div>
      {sub ? <div className="module-tile__sub">{sub}</div> : null}
    </Link>
  );
}
