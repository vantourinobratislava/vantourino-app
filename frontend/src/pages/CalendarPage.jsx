import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { AppBar } from '../components/AppBar.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { useT } from '../i18n/ui.js';
import { ridesApi } from '../api/client.js';

/*
 * Calendar — month grid with day-detail panel.
 *
 * One request per month change (browser → our backend → fan-out to BBS).
 * Each tile shows a compact preview (count badge + up to 2 lines on wider
 * viewports). Tapping a tile opens that day's bookings in a panel below.
 *
 * Layout strategy: single component, CSS-responsive at 720px. No separate
 * desktop/mobile components. On mobile the tiles compact down to just the
 * day number + a count badge; on wider screens tiles expand to fit booking
 * preview lines.
 */
export default function CalendarPage({ readOnly = false }) {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { t: tr, lang, setLang } = useT();

  const isAdmin = !!admin && !readOnly;

  // Month key (YYYY-MM) and selected day (YYYY-MM-DD).
  const [yearMonth, setYearMonth] = useState(() => todayBratislava().slice(0, 7));
  const [selected, setSelected] = useState(() => todayBratislava());

  const [month, setMonth] = useState(null); // { yearMonth, byDate, fetchedAt }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (ym) => {
    setBusy(true); setError(null);
    try {
      const out = await ridesApi.bookingsByMonth(ym);
      setMonth(out);
    } catch (e) {
      setError(e);
      setMonth(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (isAdmin) load(yearMonth); }, [isAdmin, yearMonth, load]);

  // Crew claiming. Roster maps crew_external_id → display name so slots can
  // show who holds them. Fetched once; failure degrades to read-only slots
  // (the Calendar itself still works). `iAmCrew` gates claim affordances —
  // you can only claim if you're a linked, active crew member.
  const [roster, setRoster] = useState(null);     // Map(externalId → displayName) | null
  const [crewError, setCrewError] = useState(null);
  const [crewBusy, setCrewBusy] = useState(null);  // `${bookingId}:${slot}` in flight

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    ridesApi.crewRoster()
      .then((res) => {
        if (!alive) return;
        const m = new Map();
        for (const c of (res.crew || [])) { if (c && c.externalId) m.set(c.externalId, c.displayName || c.externalId); }
        setRoster(m);
      })
      .catch(() => { if (alive) setRoster(new Map()); }); // degrade quietly
    return () => { alive = false; };
  }, [isAdmin]);

  const myExternalId = (admin && admin.crewExternalId) || null;
  const iAmCrew = !!(roster && myExternalId && roster.has(myExternalId));

  // The "already taken" notice behaves like a temporary flash: it auto-
  // hides after 5s and is cleared on any navigation or successful action
  // so it never lingers across day/month changes.
  useEffect(() => {
    if (!crewError) return undefined;
    const t = setTimeout(() => setCrewError(null), 5000);
    return () => clearTimeout(t);
  }, [crewError]);

  // Clear immediately when the selected day or the month changes.
  useEffect(() => { setCrewError(null); }, [selected]);
  useEffect(() => { setCrewError(null); }, [yearMonth]);

  // WordPress is the source of truth: after any claim/unclaim we refetch
  // the month so the slot reflects WP's authoritative state. We do NOT
  // keep final assignment state in the app.
  const runCrew = useCallback(async (fn, booking, slot) => {
    if (!booking || !booking.id) return;
    setCrewError(null);
    setCrewBusy(`${booking.id}:${slot}`);
    let failed = false;
    try {
      await fn(booking.id, slot);
    } catch (e) {
      // 409 / 422 etc. — surface the message; the refetch below resyncs
      // the slot to whoever actually holds it now.
      failed = true;
      setCrewError(e && e.message ? e.message : tr('crew_conflict'));
    } finally {
      // Refetch on both success and failure so the UI always matches WP.
      await load(yearMonth);
      // On success, make sure no stale flash remains.
      if (!failed) setCrewError(null);
      setCrewBusy(null);
    }
  }, [load, yearMonth, tr]);

  const onClaim = useCallback((b, slot) => runCrew(ridesApi.claimCrew, b, slot), [runCrew]);
  const onUnclaim = useCallback((b, slot) => runCrew(ridesApi.unclaimCrew, b, slot), [runCrew]);

  const cells = useMemo(() => buildMonthGrid(yearMonth), [yearMonth]);

  const goPrev = () => setYearMonth(shiftMonth(yearMonth, -1));
  const goNext = () => setYearMonth(shiftMonth(yearMonth, +1));
  const goToday = () => {
    const today = todayBratislava();
    setYearMonth(today.slice(0, 7));
    setSelected(today);
  };

  const onPickCell = (iso) => {
    setSelected(iso);
    const ym = iso.slice(0, 7);
    if (ym !== yearMonth) setYearMonth(ym); // jump months when tapping filler cells
  };

  const todayIso = todayBratislava();
  const selectedDay = month && month.byDate && month.byDate[selected];

  return (
    <div className="page">
      <AppBar
        title={tr('menu_calendar')}
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
            <div className="coming-soon__emoji" aria-hidden="true">📅</div>
            <p className="muted">{tr('calendar_public_note')}</p>
          </div>
        ) : (
          <div className="stack-lg">
            <div className="cal-header">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={goPrev}
                aria-label={tr('calendar_prev_month')}
              >‹</button>
              <div className="cal-header__month">
                <div className="cal-header__title">{formatMonth(yearMonth, lang)}</div>
                {yearMonth !== todayIso.slice(0, 7) ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={goToday}
                  >
                    {tr('calendar_today')}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={goNext}
                aria-label={tr('calendar_next_month')}
              >›</button>
            </div>

            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="date"
                className="input"
                value={selected}
                onChange={(e) => { if (e.target.value) onPickCell(e.target.value); }}
                style={{ maxWidth: '11rem' }}
                aria-label={tr('calendar_pick_date')}
              />
              <button
                type="button"
                className="btn btn--small"
                onClick={() => load(yearMonth)}
                disabled={busy}
              >
                {busy ? tr('common_loading') : tr('calendar_refresh')}
              </button>
              {month && month.fetchedAt ? (
                <span className="tiny muted">
                  {tr('calendar_last_refreshed', { at: formatClock(month.fetchedAt) })}
                </span>
              ) : null}
            </div>

            {error ? (
              <Alert kind="error">
                <strong>{tr('calendar_unavailable')}</strong>
                <div style={{ marginTop: 'var(--space-1)' }}>{error.message}</div>
              </Alert>
            ) : null}

            <CalendarGrid
              cells={cells}
              byDate={(month && month.byDate) || null}
              selected={selected}
              todayIso={todayIso}
              onPickCell={onPickCell}
              busy={busy}
              tr={tr}
            />

            <DayDetailPanel
              dateIso={selected}
              day={selectedDay || null}
              isToday={selected === todayIso}
              lang={lang}
              tr={tr}
              crew={{ roster, myExternalId, iAmCrew, onClaim, onUnclaim, crewBusy, crewError }}
            />
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------------- Grid ---------------- */

function CalendarGrid({ cells, byDate, selected, todayIso, onPickCell, busy, tr }) {
  const weekdayKeys = ['wd_mon', 'wd_tue', 'wd_wed', 'wd_thu', 'wd_fri', 'wd_sat', 'wd_sun'];
  return (
    <div className="cal-grid-wrap">
      <div className="cal-weekdays" aria-hidden="true">
        {weekdayKeys.map((k) => <div key={k} className="cal-weekday">{tr(k)}</div>)}
      </div>
      <div className="cal-grid">
        {cells.map((c) => {
          const day = byDate && byDate[c.iso];
          const bookings = day && Array.isArray(day.bookings) ? day.bookings : null;
          const errored = day && day.error;
          const count = bookings ? bookings.length : 0;
          const cls = [
            'cal-cell',
            c.inMonth ? '' : 'cal-cell--out',
            c.iso === selected ? 'cal-cell--selected' : '',
            c.iso === todayIso ? 'cal-cell--today' : '',
            count > 0 ? 'cal-cell--has' : '',
            errored ? 'cal-cell--err' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              type="button"
              key={c.iso}
              className={cls}
              onClick={() => onPickCell(c.iso)}
              aria-pressed={c.iso === selected}
              aria-label={`${c.iso}${count > 0 ? `, ${count} bookings` : ''}`}
            >
              <span className="cal-cell__day">{c.day}</span>
              {count > 0 ? <span className="cal-cell__count">{count}</span> : null}
              {bookings && bookings.length > 0 ? (
                <div className="cal-cell__preview" aria-hidden="true">
                  {bookings.slice(0, 2).map((b, i) => (
                    <div key={i} className="cal-cell__preview-line">
                      <span className="cal-cell__time">{b.startTime || ''}</span>
                      <span className="cal-cell__title">{b.rideName || tr('rides_untitled')}</span>
                    </div>
                  ))}
                  {bookings.length > 2 ? (
                    <div className="cal-cell__more">
                      {tr('calendar_more_n', { n: bookings.length - 2 })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {errored ? <span className="cal-cell__err-mark" title={day.error} aria-label="error">⚠</span> : null}
            </button>
          );
        })}
      </div>
      {busy && !byDate ? <Spinner label={tr('common_loading')} /> : null}
    </div>
  );
}

/* ---------------- Day detail ---------------- */

function DayDetailPanel({ dateIso, day, isToday, lang, tr, crew }) {
  return (
    <section className="cal-day-detail">
      <header className="cal-day-detail__header">
        <h2 className="cal-day-detail__title">
          {formatDateLong(dateIso, lang)}
          {isToday ? <span className="cal-day-detail__today-pill">{tr('calendar_today_marker')}</span> : null}
        </h2>
      </header>

      {crew && crew.crewError ? (
        <Alert kind="warn">{crew.crewError}</Alert>
      ) : null}

      {!day ? (
        <p className="muted small">{tr('calendar_tap_a_day')}</p>
      ) : day.error ? (
        <Alert kind="warn">{day.error}</Alert>
      ) : !day.bookings || day.bookings.length === 0 ? (
        <p className="muted">{tr('calendar_day_empty')}</p>
      ) : (
        <ul className="calendar-agenda">
          {day.bookings.map((b, i) => (
            <AgendaEvent key={`${b.id || b.bookingNumber || 'b'}-${i}`} booking={b} tr={tr} crew={crew} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgendaEvent({ booking, tr, crew }) {
  const b = booking;
  const timeRange = (() => {
    if (b.startTime && b.endTime) return `${b.startTime} – ${b.endTime}`;
    return b.startTime || b.endTime || '';
  })();
  return (
    <li className="agenda-event">
      <div className="agenda-event__time">
        <span className="agenda-event__time-range">{timeRange || '—'}</span>
        {b.duration ? <span className="agenda-event__duration">({b.duration})</span> : null}
      </div>
      <div className="agenda-event__body">
        <div className="agenda-event__title">{b.rideName || tr('rides_untitled')}</div>
        <div className="agenda-event__meta">
          <span className="status-pill status-pill--scheduled">
            {tr('rides_pax_n', { n: b.groupSize || 0 })}
          </span>
          {b.country ? <span className="muted small">{b.country}</span> : null}
        </div>
        {crew && b.id ? (
          <div className="crew-slots">
            <CrewSlot booking={b} slot="driver" occupantId={b.crew1ExternalId} occupantLabel={b.crew1Label} pay={b.driverPay} label={tr('crew_driver')} tr={tr} crew={crew} />
            <CrewSlot booking={b} slot="guide" occupantId={b.crew2ExternalId} occupantLabel={b.crew2Label} pay={b.guidePay} label={tr('crew_guide')} tr={tr} crew={crew} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/*
 * One crew slot (driver or guide). Ownership is derived from the
 * CANONICAL crew_*_external_id value (occupantId), never from the display
 * name:
 *   - free      → no external id in the slot
 *   - mine      → external id === my external id
 *   - occupied  → external id === someone else
 * For an occupied slot we show the name WP gave us (occupantLabel), then
 * the roster name, then a generic fallback. Claim is offered only to a
 * linked crew member on a free slot; unclaim only on your own. WP is the
 * final authority and returns 409 on a lost race.
 */
function CrewSlot({ booking, slot, occupantId, occupantLabel, pay, label, tr, crew }) {
  const { roster, myExternalId, iAmCrew, onClaim, onUnclaim, crewBusy } = crew;
  const busy = crewBusy === `${booking.id}:${slot}`;

  let state = 'free';
  if (occupantId) state = occupantId === myExternalId ? 'mine' : 'occupied';

  const occupantName = occupantId
    ? (occupantLabel || (roster && roster.get(occupantId)) || tr('crew_unknown'))
    : null;

  // Earnings are shown ONLY for the slot the current admin holds.
  //  - rate: shown when present (a per-booking amount); omitted if null.
  //  - bonus: shown ONLY when bonusIsOverride === true (a booking-specific
  //    override). A null bonus with override=false is a day-level default
  //    and must NOT render as €0.00. An explicit 0 override DOES show.
  const showEarnings = state === 'mine' && pay && typeof pay === 'object';
  const showRate = showEarnings && pay.rateCents != null;
  const showBonus = showEarnings && pay.bonusIsOverride === true && pay.bonusCents != null;

  return (
    <div className={`crew-slot crew-slot--${state}`}>
      <div className="crew-slot__main">
        <span className="crew-slot__label">{label}</span>
        {state === 'free' ? (
          iAmCrew ? (
            <button
              type="button"
              className="btn btn--small btn--accent crew-slot__btn"
              onClick={() => onClaim(booking, slot)}
              disabled={busy}
            >
              {busy ? tr('crew_working') : tr('crew_claim')}
            </button>
          ) : (
            <span className="crew-slot__status">{tr('crew_free')}</span>
          )
        ) : state === 'mine' ? (
          <span className="crew-slot__assigned">
            <span className="crew-slot__you">{tr('crew_mine')}</span>
            <button
              type="button"
              className="btn btn--small btn--ghost crew-slot__btn"
              onClick={() => onUnclaim(booking, slot)}
              disabled={busy}
            >
              {busy ? tr('crew_working') : tr('crew_unclaim')}
            </button>
          </span>
        ) : (
          <span className="crew-slot__status crew-slot__status--occupied" title={tr('crew_occupied_title')}>
            {occupantName}
          </span>
        )}
      </div>
      {showRate || showBonus ? (
        <div className="crew-slot__pay">
          {showRate ? (
            <span className="crew-slot__pay-item">
              <span className="crew-slot__pay-label">{tr('crew_rate')}</span>
              <span className="crew-slot__pay-amount">{formatEur(pay.rateCents)}</span>
            </span>
          ) : null}
          {showBonus ? (
            <span className="crew-slot__pay-item crew-slot__pay-item--bonus">
              <span className="crew-slot__pay-label">{tr('crew_bonus')}</span>
              <span className="crew-slot__pay-amount">{formatEur(pay.bonusCents)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- helpers ---------------- */

function formatEur(cents) {
  const n = Number(cents) || 0;
  return `€${(n / 100).toFixed(2)}`;
}

function todayBratislava() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shiftMonth(yearMonth, deltaMonths) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) return todayBratislava().slice(0, 7);
  const [y, m] = yearMonth.split('-').map(Number);
  // Use UTC arithmetic on the 1st of the month — no DST edge cases.
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Build a 6×7 month grid (42 cells) starting on Monday. Outside-month cells
 * are included with `inMonth: false`. All math is pure UTC-midnight to avoid
 * DST edges.
 */
function buildMonthGrid(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  // JS getUTCDay(): 0=Sun, 1=Mon … 6=Sat. Map to Monday-first index.
  const firstDow = (first.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  // Start the grid on the Monday on/before the 1st.
  const start = new Date(Date.UTC(y, m - 1, 1 - firstDow));
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    cells.push({
      iso: `${yy}-${mm}-${dd}`,
      day: dt.getUTCDate(),
      inMonth: dt.getUTCMonth() === m - 1,
    });
  }
  return cells;
}

function formatMonth(yearMonth, lang) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) return yearMonth || '';
  const [y, m] = yearMonth.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  const locale = (lang === 'sk') ? 'sk-SK' : (lang === 'de') ? 'de-DE' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      month: 'long', year: 'numeric',
    }).format(dt);
  } catch (_err) {
    return yearMonth;
  }
}

function formatDateLong(iso, lang) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const locale = (lang === 'sk') ? 'sk-SK' : (lang === 'de') ? 'de-DE' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    }).format(dt);
  } catch (_err) {
    return iso;
  }
}

function formatClock(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bratislava',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_err) {
    return '';
  }
}
