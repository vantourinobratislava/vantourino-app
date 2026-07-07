import { useState, useEffect, useCallback } from 'react';

/*
 * Quiz-content language selection.
 *
 * This controls the language of QUIZ CONTENT (prompts, options) — not UI
 * labels. It's persisted in localStorage so a refresh keeps the choice.
 *
 * Admin and team each read/write the same key, but they're separate browser
 * contexts (different devices), so they pick independently. That's the
 * intended behavior: a German-speaking team can view German while the host
 * runs the room in Slovak.
 */

export const LANGS = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'sk', label: 'SK', name: 'Slovenčina' },
  { code: 'de', label: 'DE', name: 'Deutsch' },
];

const CODES = LANGS.map((l) => l.code);
const DEFAULT = 'en';
const STORAGE_KEY = 'bbqa.lang';

export function getStoredLang() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && CODES.includes(v)) return v;
  } catch {/* ignore */}
  return DEFAULT;
}

function storeLang(lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {/* ignore */}
}

/*
 * Shared in-tab language state.
 *
 * Previously each useLang() call held its own useState, synced across tabs only
 * via the 'storage' event (which never fires in the tab that made the change).
 * That meant a switcher in one component updated only that component's copy —
 * sibling components (e.g. live-session sub-panels reading the UI language via
 * useT) kept a stale value and didn't re-translate. We now keep ONE module-level
 * value with a subscriber set, so any setLang updates every consumer in the tab
 * immediately. localStorage persistence and cross-tab sync are preserved.
 */
let currentLang = getStoredLang();
const listeners = new Set();

function setGlobalLang(next) {
  if (!CODES.includes(next) || next === currentLang) return;
  currentLang = next;
  storeLang(next);
  listeners.forEach((fn) => fn(currentLang));
}

/** Hook: returns [lang, setLang]. Shared across all consumers in the tab. */
export function useLang() {
  const [lang, setLangState] = useState(currentLang);

  useEffect(() => {
    // Subscribe to in-tab changes.
    const onChange = (next) => setLangState(next);
    listeners.add(onChange);
    // In case the value changed between render and effect, resync.
    if (lang !== currentLang) setLangState(currentLang);

    // Cross-tab sync: mirror another tab's choice into our shared value.
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY && e.newValue && CODES.includes(e.newValue)) {
        if (e.newValue !== currentLang) {
          currentLang = e.newValue;
          listeners.forEach((fn) => fn(currentLang));
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener('storage', onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLang = useCallback((next) => { setGlobalLang(next); }, []);

  return [lang, setLang];
}
