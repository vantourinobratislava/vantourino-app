import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { AppBar } from '../components/AppBar.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { useT } from '../i18n/ui.js';
import { ridesApi } from '../api/client.js';

/*
 * Rides page — Phase 2.
 *
 * Read-through operational view sourced from the BBS Booking REST API. No
 * DB persistence; each Refresh click hits the upstream via our backend
 * proxy. The page always renders — on upstream failure it shows a clear
 * "unavailable" card and the Refresh button stays usable.
 *
 * Public route still uses this component in readOnly mode; it shows a
 * staff-only note (no upstream calls).
 */
export default function RidesPage({ readOnly = false }) {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isAdmin = !!admin && !readOnly;

  const [data, setData] = useState(null); // { date, bookings, fetchedAt }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const out = await ridesApi.bookingsToday();
      setData(out);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  // First load when admin opens the page.
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  return (
    <div className="page">
      <AppBar
        title={tr('menu_rides')}
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
            <div className="coming-soon__emoji" aria-hidden="true">🚲</div>
            <p className="muted">{tr('rides_public_note')}</p>
          </div>
        ) : (
          <div className="stack-lg">
            <div className="row row--between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <div className="stack-tight" style={{ gap: 0 }}>
                <h2 style={{ fontSize: '1rem', margin: 0 }}>
                  {tr('rides_today')}{data && data.date ? ` (${formatDate(data.date)})` : ''}
                </h2>
                {data && data.fetchedAt ? (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    {tr('rides_last_refreshed', { at: formatTime(data.fetchedAt) })}
                  </p>
                ) : null}
              </div>
              <button
                className="btn btn--accent btn--small"
                onClick={load}
                disabled={busy}
              >
                {busy ? tr('rides_refreshing') : tr('rides_refresh_today')}
              </button>
            </div>

            {error ? (
              <Alert kind="error">
                <strong>{tr('rides_unavailable')}</strong>
                <div style={{ marginTop: 'var(--space-1)' }}>{error.message}</div>
              </Alert>
            ) : data === null && busy ? (
              <Spinner label={tr('common_loading')} />
            ) : data === null ? (
              <p className="muted small">{tr('rides_press_refresh')}</p>
            ) : data.bookings.length === 0 ? (
              <p className="muted">{tr('rides_today_empty')}</p>
            ) : (
              <ul className="rides-list">
                {(() => {
                  const { index: activeIndex, kind: activeKind } = pickActiveBooking(data.bookings);
                  return data.bookings.map((b, i) => (
                    <BookingCard
                      key={`${b.bookingNumber || 'b'}-${i}`}
                      booking={b}
                      isActive={i === activeIndex}
                      activeKind={i === activeIndex ? activeKind : null}
                    />
                  ));
                })()}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------------- Booking card ---------------- */

function BookingCard({ booking, isActive = false, activeKind = null }) {
  const { t: tr } = useT();
  const b = booking;

  const timeRange = (() => {
    if (b.startTime && b.endTime) return `${b.startTime} – ${b.endTime}`;
    return b.startTime || b.endTime || '';
  })();

  const cardClass = isActive ? 'ride-item booking-card booking-card--active' : 'ride-item booking-card';
  const activeLabel = activeKind === 'in_progress'
    ? tr('rides_in_progress')
    : activeKind === 'up_next'
      ? tr('rides_up_next')
      : null;

  return (
    <li className={cardClass}>
      {activeLabel ? (
        <span className="booking-card__active-label">{activeLabel}</span>
      ) : null}

      <div className="ride-item__top">
        <span className="ride-item__time">{timeRange || '—'}</span>
        {b.duration ? <span className="muted small">({b.duration})</span> : null}
        <span className="ride-item__title">{b.rideName || tr('rides_untitled')}</span>
      </div>

      {b.bookingNumber ? (
        <p className="booking-card__number">#{b.bookingNumber}</p>
      ) : null}

      <div className="ride-item__meta" style={{ marginTop: 'var(--space-2)' }}>
        <span className="status-pill status-pill--scheduled">
          {tr('rides_pax_n', { n: b.groupSize || 0 })}
        </span>
        {b.dueAmountCents > 0 ? (
          <span className="status-pill status-pill--due">
            {formatEur(b.dueAmountCents)}
          </span>
        ) : null}
      </div>

      {b.extras && b.extras.length > 0 ? (
        <div className="booking-extras">
          <span className="tiny muted" style={{ marginRight: 'var(--space-2)' }}>
            {tr('rides_extras')}:
          </span>
          {b.extras.map((x, i) => (
            <span key={i} className="extras-chip">{x}</span>
          ))}
        </div>
      ) : null}

      {(b.customerName || b.customerPhone || b.country) ? (
        <div className="booking-customer">
          {b.customerName ? <div className="booking-customer__name">{b.customerName}</div> : null}
          {b.customerPhone ? (
            <div>
              <a className="booking-customer__phone" href={`tel:${b.customerPhone.replace(/[^\d+]/g, '')}`}>
                {b.customerPhone}
              </a>
            </div>
          ) : null}
          {b.country ? <div className="muted small">{b.country}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

/* ---------------- formatters + helpers ---------------- */

/**
 * Pick which booking deserves the visual highlight.
 *
 *   - in_progress: a booking whose [startTime, endTime) brackets "now"
 *     (Bratislava local). If several overlap, the first in upstream order
 *     wins — deterministic and matches what the operator visually scans
 *     first.
 *   - up_next: the first booking with startTime strictly after now.
 *   - none: all bookings are in the past (or no times present).
 *
 * Lexicographic comparison on HH:MM is correct for same-day comparison;
 * upstream already orders the list by start time ASC.
 */
function pickActiveBooking(bookings) {
  if (!Array.isArray(bookings) || bookings.length === 0) {
    return { index: -1, kind: null };
  }
  const now = nowHHMMLocal();

  // First: anything currently in progress.
  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    if (!b || !b.startTime) continue;
    if (b.endTime && b.startTime <= now && now < b.endTime) {
      return { index: i, kind: 'in_progress' };
    }
  }
  // Otherwise: the nearest upcoming.
  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    if (!b || !b.startTime) continue;
    if (b.startTime > now) {
      return { index: i, kind: 'up_next' };
    }
  }
  return { index: -1, kind: null };
}

function nowHHMMLocal() {
  // 'HH:MM' in Bratislava local — matches upstream `start_time` semantics
  // regardless of the operator's device TZ.
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bratislava',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  } catch (_err) {
    // Last-resort fallback to device TZ; only used if Intl misbehaves.
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function formatDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatTime(iso) {
  // 'HH:MM' in Bratislava local time so the operator sees the right wall clock.
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bratislava',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_err) {
    return '';
  }
}

function formatEur(cents) {
  const n = Number(cents) || 0;
  // EUR, two decimals, locale separators stripped to keep it short on mobile.
  const euro = (n / 100).toFixed(2);
  return `€${euro}`;
}
