/*
 * Team session storage.
 *
 * Keyed by session code so two team-side tabs (e.g. different sessions) don't
 * collide. We use localStorage so a refresh keeps the team logged in.
 *
 * Shape stored under each key:
 *   { sessionCode, teamId, teamName, joinedAt, token }
 */

const PREFIX = 'bbqa.team.';

function key(sessionCode) { return PREFIX + sessionCode; }

export function saveTeamSession(sessionCode, data) {
  try {
    localStorage.setItem(key(sessionCode), JSON.stringify(data));
  } catch {
    // localStorage disabled (private mode, full disk). Token still works
    // for this navigation via React state; the caller should pass it down.
  }
}

export function loadTeamSession(sessionCode) {
  try {
    const raw = localStorage.getItem(key(sessionCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearTeamSession(sessionCode) {
  try { localStorage.removeItem(key(sessionCode)); } catch {/* ignore */}
}
