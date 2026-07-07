import { useT } from '../i18n/ui.js';

/*
 * ItemKindBadge — the single source of truth for item-type badges.
 *
 * Maps a backend `kind` to a localized label + a color class. The backend still
 * uses kind='contest' (unchanged for data/scoring compatibility); we present it
 * as "Challenge". A missing/unknown kind is treated as a question.
 *
 *   question  → blue
 *   contest/challenge → amber  (same thing; 'contest' is the legacy value)
 *   audio     → purple
 *
 * Usage: <ItemKindBadge kind={item.kind} />   (optionally size="sm")
 */
export function ItemKindBadge({ kind, size }) {
  const { t } = useT();
  const norm = normalizeKind(kind);
  const labelKey = norm === 'challenge' ? 'kind_challenge' : norm === 'audio' ? 'kind_audio' : 'kind_question';
  return (
    <span className={`kind-badge kind-badge--${norm}${size === 'sm' ? ' kind-badge--sm' : ''}`}>
      {t(labelKey)}
    </span>
  );
}

/** contest (legacy) and challenge are the same type; everything else falls back. */
export function normalizeKind(kind) {
  if (kind === 'contest' || kind === 'challenge') return 'challenge';
  if (kind === 'audio') return 'audio';
  return 'question';
}
