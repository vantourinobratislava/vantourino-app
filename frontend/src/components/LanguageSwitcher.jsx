import { LANGS } from '../i18n/lang.js';

/*
 * Flag-based language switcher for quiz CONTENT language (SK / EN / DE).
 *
 * Robust prop contract: the active language can be passed as `lang` OR `value`,
 * and the change handler as `onChange` OR `setLang` OR `onSelect`. Whichever is
 * provided is used. This prevents the "click does nothing" bug that occurs when
 * a caller and the component disagree on the prop name.
 *
 * `available` (optional) limits which languages are shown — useful when a quiz
 * only has some translations. Falls back to all languages if not provided.
 */

// Flag glyph per language code (regional-indicator emoji).
const FLAGS = {
  en: '🇬🇧',
  sk: '🇸🇰',
  de: '🇩🇪',
};

export function LanguageSwitcher(props) {
  const {
    lang,
    value,
    onChange,
    setLang,
    onSelect,
    available,
    light = false,
    compact = false,
  } = props;

  // Resolve the active code and the handler from whichever prop was passed.
  const active = lang != null ? lang : value;
  const handler = onChange || setLang || onSelect;

  const shown = (available && available.length)
    ? LANGS.filter((l) => available.includes(l.code))
    : LANGS;

  // If only one language exists, no point showing a switcher.
  if (shown.length <= 1) return null;

  const choose = (code) => {
    if (typeof handler === 'function') handler(code);
  };

  // Compact mode: a small dropdown for the top bar (used on session/live
  // screens). Same behavior, less horizontal space, mobile-friendly.
  if (compact) {
    return (
      <select
        className={`langselect${light ? ' langselect--light' : ''}`}
        aria-label="Quiz language"
        value={active != null ? active : (shown[0] && shown[0].code)}
        onChange={(e) => choose(e.target.value)}
      >
        {shown.map((l) => (
          <option key={l.code} value={l.code}>
            {(FLAGS[l.code] ? FLAGS[l.code] + ' ' : '') + (l.label || l.name)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className={`langswitch${light ? ' langswitch--light' : ''}`} role="group" aria-label="Quiz language">
      {shown.map((l) => (
        <button
          key={l.code}
          type="button"
          className={`langswitch__btn${active === l.code ? ' langswitch__btn--active' : ''}`}
          aria-pressed={active === l.code}
          aria-label={l.name || l.label}
          title={l.name || l.label}
          onClick={() => choose(l.code)}
        >
          <span aria-hidden="true">{FLAGS[l.code] || l.label}</span>
        </button>
      ))}
    </div>
  );
}
