/*
 * API client. Single place that knows how to talk to the backend.
 *
 * Same-origin in prod (recommended): leave VITE_API_BASE_URL blank, deploy
 * the frontend behind the same domain as the backend.
 *
 * Dev: vite.config.js proxies /api → backend so cookies work without CORS.
 *
 * Cross-origin (advanced): set VITE_API_BASE_URL and configure backend CORS +
 * cookie sameSite=None; secure.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

/** Error from the API — has .status (HTTP code) and .body (parsed JSON or null). */
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers = {}, credentials, isForm = false } = {}) {
  const url = `${BASE_URL}${path}`;

  const init = {
    method,
    headers: {
      Accept: 'application/json',
      // For multipart (FormData) the browser must set Content-Type itself
      // (it includes the boundary), so we don't set it here.
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : null),
      ...headers,
    },
  };
  if (body !== undefined) init.body = isForm ? body : JSON.stringify(body);
  if (credentials) init.credentials = credentials;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, 'Network error. Check your connection and try again.', null);
  }

  // Handle empty bodies (204, etc.)
  let payload = null;
  const contentType = res.headers.get('content-type') || '';
  if (res.status !== 204 && contentType.includes('application/json')) {
    try { payload = await res.json(); } catch { payload = null; }
  }

  if (!res.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      defaultMessageForStatus(res.status);
    throw new ApiError(res.status, message, payload);
  }
  return payload;
}

function defaultMessageForStatus(status) {
  if (status === 401) return 'Not authorized.';
  if (status === 403) return 'Access denied.';
  if (status === 404) return 'Not found.';
  if (status === 409) return 'Conflict.';
  if (status >= 500) return 'Server error. Please try again.';
  return `Request failed (${status}).`;
}

/* ---------- Admin (cookie session) ---------- */
const ADMIN_OPTS = { credentials: 'include' };

export const adminApi = {
  login: (username, password) =>
    request('/api/admin/login', { method: 'POST', body: { username, password }, ...ADMIN_OPTS }),
  logout: () =>
    request('/api/admin/logout', { method: 'POST', ...ADMIN_OPTS }),
  me: () =>
    request('/api/admin/me', { ...ADMIN_OPTS }),

  // payload: { translations: { en: { title, description }, ... } }
  // (legacy { title, description } also accepted by the backend)
  createQuiz: (payload) =>
    request('/api/admin/quizzes', { method: 'POST', body: payload, ...ADMIN_OPTS }),

  listQuizzes: (lang, includeArchived = false) =>
    request(`/api/admin/quizzes?${new URLSearchParams({
      ...(lang ? { lang } : {}),
      ...(includeArchived ? { includeArchived: '1' } : {}),
    }).toString()}`, { ...ADMIN_OPTS }),

  // Lighter-weight quiz list used by the "Start a session" picker.
  // Gated on `challenges` only (not `manage_quizzes`), so operators who
  // can host but not author can still select a quiz. Returns id + title
  // + questionCount + languages; excludes archived.
  listQuizzesForHosting: (lang) =>
    request(`/api/admin/quiz-sessions/quizzes-for-hosting${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { ...ADMIN_OPTS }),

  // Full multilingual quiz for the editor.
  getQuiz: (quizId) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}`, { ...ADMIN_OPTS }),

  // Update quiz title/description translations.
  // payload: { translations: { en: { title, description? }, ... } }
  updateQuiz: (quizId, payload) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}`, {
      method: 'PATCH', body: payload, ...ADMIN_OPTS,
    }),

  // Update a question's text/points/correct option (no structural change).
  // payload: { points?, correctOptionId?, prompts?: {en,sk,de}, options?: [{id, texts:{...}}] }
  updateQuestion: (quizId, questionId, payload) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}/questions/${encodeURIComponent(questionId)}`, {
      method: 'PATCH', body: payload, ...ADMIN_OPTS,
    }),

  // Delete a single quiz item (question or contest); renumbers the rest.
  deleteQuestion: (quizId, questionId) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}/questions/${encodeURIComponent(questionId)}`, {
      method: 'DELETE', ...ADMIN_OPTS,
    }),

  // Delete (hard-delete if unused, else archive).
  deleteQuiz: (quizId) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}`, {
      method: 'DELETE', ...ADMIN_OPTS,
    }),

  duplicateQuiz: (quizId) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}/duplicate`, {
      method: 'POST', ...ADMIN_OPTS,
    }),

  // Reorder a quiz's questions. orderedIds = full permutation of question IDs.
  reorderQuestions: (quizId, orderedIds) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}/questions/order`, {
      method: 'PATCH', body: { orderedIds }, ...ADMIN_OPTS,
    }),

  // Bulk import: preview takes a File (multipart); commit takes the payload.
  importPreview: (file) => {
    const form = new FormData();
    form.append('file', file);
    // Note: no Content-Type header — the browser sets the multipart boundary.
    return request('/api/admin/quizzes/import/preview', {
      method: 'POST', body: form, isForm: true, ...ADMIN_OPTS,
    });
  },
  importCommit: (payload) =>
    request('/api/admin/quizzes/import/commit', {
      method: 'POST', body: { payload }, ...ADMIN_OPTS,
    }),

  // Session history
  listSessions: (lang) =>
    request(`/api/admin/quiz-sessions${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { ...ADMIN_OPTS }),
  getSessionSummary: (sessionCode, lang) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/summary${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { ...ADMIN_OPTS }),
  deleteSession: (sessionCode) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}`, {
      method: 'DELETE', ...ADMIN_OPTS,
    }),

  addQuestion: (quizId, payload) =>
    request(`/api/admin/quizzes/${encodeURIComponent(quizId)}/questions`, {
      method: 'POST', body: payload, ...ADMIN_OPTS,
    }),

  createSession: ({ quizId, answerTimeSeconds }) =>
    request('/api/admin/quiz-sessions', {
      method: 'POST',
      body: { quizId, answerTimeSeconds },
      ...ADMIN_OPTS,
    }),
  getSession: (sessionCode, lang) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { ...ADMIN_OPTS }),
  startSession: (sessionCode) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/start`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
  startQuestion: (sessionCode, questionId) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/start`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
  finishQuestion: (sessionCode, questionId) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/finish`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
  pauseQuestion: (sessionCode, questionId) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/pause`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
  resumeQuestion: (sessionCode, questionId) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/resume`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
  awardContest: (sessionCode, questionId, awards) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/award`, {
      method: 'POST', body: { awards }, ...ADMIN_OPTS,
    }),
  getCurrentQuestion: (sessionCode, lang, audioLang) => {
    const params = [];
    if (lang) params.push(`lang=${encodeURIComponent(lang)}`);
    if (audioLang) params.push(`audioLang=${encodeURIComponent(audioLang)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/current-question${qs}`, { ...ADMIN_OPTS });
  },
  getLiveStatus: (sessionCode) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/live-status`, { ...ADMIN_OPTS }),
  getCurrentResults: (sessionCode, lang) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/results/current${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { ...ADMIN_OPTS }),
  getFinalResults: (sessionCode) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/results/final`, { ...ADMIN_OPTS }),
  closeSession: (sessionCode) =>
    request(`/api/admin/quiz-sessions/${encodeURIComponent(sessionCode)}/close`, {
      method: 'POST', ...ADMIN_OPTS,
    }),
};

/* ---------- Public / team ---------- */
export const publicApi = {
  join: (sessionCode, teamName) =>
    request(`/api/session/${encodeURIComponent(sessionCode)}/join`, {
      method: 'POST',
      body: { teamName },
    }),
  getCurrentQuestion: (sessionCode, lang) =>
    request(`/api/session/${encodeURIComponent(sessionCode)}/current-question${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),
  submitAnswer: (sessionCode, questionId, optionId, teamToken) =>
    request(`/api/session/${encodeURIComponent(sessionCode)}/questions/${encodeURIComponent(questionId)}/answer`, {
      method: 'POST',
      body: { optionId },
      headers: { Authorization: `Bearer ${teamToken}` },
    }),
  getCurrentResults: (sessionCode, lang) =>
    request(`/api/session/${encodeURIComponent(sessionCode)}/results/current${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),
  getFinalResults: (sessionCode) =>
    request(`/api/session/${encodeURIComponent(sessionCode)}/results/final`),
};

/* ---------- Modules: Rules, Sirups ---------- */
export const modulesApi = {
  // Public reads
  getRules: (lang) =>
    request(`/api/modules/rules${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),
  listSirups: (lang) =>
    request(`/api/modules/sirups${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),

  // Admin reads/writes
  getRulesFull: () =>
    request('/api/admin/modules/rules', { ...ADMIN_OPTS }),
  setRules: (translations) =>
    request('/api/admin/modules/rules', { method: 'PUT', body: { translations }, ...ADMIN_OPTS }),

  listSirupsFull: () =>
    request('/api/admin/modules/sirups', { ...ADMIN_OPTS }),
  createSirup: (translations) =>
    request('/api/admin/modules/sirups', { method: 'POST', body: { translations }, ...ADMIN_OPTS }),
  updateSirup: (id, translations) =>
    request(`/api/admin/modules/sirups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { translations }, ...ADMIN_OPTS }),
  deleteSirup: (id) =>
    request(`/api/admin/modules/sirups/${encodeURIComponent(id)}`, { method: 'DELETE', ...ADMIN_OPTS }),
};

/* ---------- Audioguides library (Phase B1) ---------- */
export const audioApi = {
  list: () =>
    request('/api/admin/audio', { ...ADMIN_OPTS }),

  // files: FileList | File[]; optional title applies only when exactly one file.
  upload: (files, title) => {
    const fd = new FormData();
    const arr = Array.from(files || []);
    for (const f of arr) fd.append('files', f);
    if (arr.length === 1 && title && title.trim()) fd.append('title', title.trim());
    return request('/api/admin/audio', { method: 'POST', body: fd, isForm: true, ...ADMIN_OPTS });
  },

  rename: (id, title) =>
    request(`/api/admin/audio/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title }, ...ADMIN_OPTS }),

  remove: (id) =>
    request(`/api/admin/audio/${encodeURIComponent(id)}`, { method: 'DELETE', ...ADMIN_OPTS }),

  // Replace the underlying file for an existing recording (preserves id,
  // title, guide attachment, language).
  replaceFile: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request(`/api/admin/audio/${encodeURIComponent(id)}/file`, { method: 'PUT', body: fd, isForm: true, ...ADMIN_OPTS });
  },

  // Public streaming URL (Range-enabled). Used directly as <audio src>.
  streamUrl: (id) => `${BASE_URL}/api/audio/${encodeURIComponent(id)}/stream`,

  /* ---- B2.1: guides + variants ---- */
  listGuides: () =>
    request('/api/admin/audio/guides', { ...ADMIN_OPTS }),
  createGuide: ({ title, description } = {}) =>
    request('/api/admin/audio/guides', { method: 'POST', body: { title, description }, ...ADMIN_OPTS }),
  renameGuide: (id, { title, description } = {}) =>
    request(`/api/admin/audio/guides/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title, description }, ...ADMIN_OPTS }),
  removeGuide: (id) =>
    request(`/api/admin/audio/guides/${encodeURIComponent(id)}`, { method: 'DELETE', ...ADMIN_OPTS }),

  attach: (recordingId, { guideId, lang }) =>
    request(`/api/admin/audio/${encodeURIComponent(recordingId)}/attach`, { method: 'POST', body: { guideId, lang }, ...ADMIN_OPTS }),
  detach: (recordingId) =>
    request(`/api/admin/audio/${encodeURIComponent(recordingId)}/detach`, { method: 'POST', ...ADMIN_OPTS }),
};

// 6-language audio support, used by Audioguides UI for variant slots.
export const AUDIO_LANGS = [
  { code: 'en', label: 'EN' },
  { code: 'de', label: 'DE' },
  { code: 'sk', label: 'SK' },
  { code: 'it', label: 'IT' },
  { code: 'es', label: 'ES' },
  { code: 'fr', label: 'FR' },
];

// Rides admin API (Phase 2). Read-through proxy to the BBS Booking REST API.
// No DB persistence; the page calls bookingsToday() on each refresh.
// Admin Users management (Phase 1C-B). Super_admin only — backend gates
// every call; the frontend page is also super_admin-only as UX courtesy.
export const usersApi = {
  meta: () =>
    request('/api/admin/users/meta', { ...ADMIN_OPTS }),
  list: () =>
    request('/api/admin/users', { ...ADMIN_OPTS }),
  create: ({ username, password, role }) =>
    request('/api/admin/users', { method: 'POST', body: { username, password, role }, ...ADMIN_OPTS }),
  setRole: (id, role) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/role`, { method: 'PATCH', body: { role }, ...ADMIN_OPTS }),
  setActive: (id, isActive) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/active`, { method: 'PATCH', body: { isActive }, ...ADMIN_OPTS }),
  setPassword: (id, password) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: 'PUT', body: { password }, ...ADMIN_OPTS }),
  // Pass `null` to reset to role defaults; otherwise a full override map.
  setPermissions: (id, permissions) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/permissions`, { method: 'PUT', body: { permissions }, ...ADMIN_OPTS }),
  // Manual WP pairing. Pass '' or null to unpair.
  setCrewExternalId: (id, crewExternalId) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/crew-external-id`, { method: 'PUT', body: { crewExternalId }, ...ADMIN_OPTS }),
};

export const ridesApi = {
  bookingsToday: () =>
    request('/api/admin/rides/bookings/today', { ...ADMIN_OPTS }),
  bookingsByDate: (date) =>
    request(`/api/admin/rides/bookings/by-date?date=${encodeURIComponent(date)}`, { ...ADMIN_OPTS }),
  bookingsByMonth: (yearMonth) =>
    request(`/api/admin/rides/bookings/month?yearMonth=${encodeURIComponent(yearMonth)}`, { ...ADMIN_OPTS }),

  // Crew claiming. Roster resolves crew_external_id → display name; the
  // claim/unclaim calls inject the caller's own external id server-side
  // (the browser never names who it assigns).
  crewRoster: () =>
    request('/api/admin/rides/crew', { ...ADMIN_OPTS }),
  claimCrew: (bookingId, slot) =>
    request(`/api/admin/rides/bookings/${encodeURIComponent(bookingId)}/crew/claim`, { method: 'POST', body: { slot }, ...ADMIN_OPTS }),
  unclaimCrew: (bookingId, slot) =>
    request(`/api/admin/rides/bookings/${encodeURIComponent(bookingId)}/crew/unclaim`, { method: 'POST', body: { slot }, ...ADMIN_OPTS }),
};
