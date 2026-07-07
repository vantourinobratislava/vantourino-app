/* Tiny stateless components used across screens. */

export function Alert({ kind = 'info', children, role }) {
  return <div className={`alert alert--${kind}`} role={role || (kind === 'error' ? 'alert' : 'status')}>{children}</div>;
}

export function Spinner({ label }) {
  return (
    <div className="loading-block">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

/** Status badge that uses our colored CSS for each known status. */
export function StatusBadge({ status }) {
  if (!status) return null;
  return <span className={`badge badge--${status}`}>{status.replace('_', ' ')}</span>;
}

/**
 * Background-poll indicator. Intentionally renders nothing: background
 * refreshes are silent so the page never shows a flickering "updating…" label
 * or reflows every poll cycle. Kept as a no-op so existing call sites (which
 * pass `stale`) remain valid without edits.
 */
export function StaleHint() {
  return null;
}
