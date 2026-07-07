'use strict';

const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const { SUPPORTED_LANGS, normalizeLang, isSupported } = require('../utils/languages');

/* ===================== App content (Rules) ===================== */

/** Resolve a content block to one language (fallback lang -> order -> null). */
async function getContent(contentKey, langInput) {
  const want = normalizeLang(langInput);
  const { rows } = await pool.query(
    `SELECT lang, title, body FROM app_content WHERE content_key = $1`,
    [contentKey]
  );
  const byLang = {};
  for (const r of rows) byLang[r.lang] = r;
  let pick = byLang[want];
  if (!pick) for (const l of SUPPORTED_LANGS) { if (byLang[l]) { pick = byLang[l]; break; } }
  if (!pick && rows.length) pick = rows[0];
  return {
    key: contentKey,
    lang: pick ? pick.lang : want,
    title: pick ? pick.title : null,
    body: pick ? pick.body : null,
  };
}

/** All languages for the editor. */
async function getContentAll(contentKey) {
  const { rows } = await pool.query(
    `SELECT lang, title, body FROM app_content WHERE content_key = $1`,
    [contentKey]
  );
  const translations = {};
  for (const r of rows) translations[r.lang] = { title: r.title, body: r.body };
  return { key: contentKey, translations };
}

/** Upsert content for the provided languages.
 * translations = { en: { title?, body? }, sk: {...}, de: {...} } */
async function setContent(contentKey, translations) {
  if (!translations || typeof translations !== 'object') {
    throw new HttpError(400, 'translations are required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [rawLang, val] of Object.entries(translations)) {
      if (!isSupported(rawLang)) continue;
      const lang = rawLang.toLowerCase();
      const title = val && val.title != null ? String(val.title).slice(0, 255) : null;
      const body = val && val.body != null ? String(val.body).slice(0, 20000) : null;
      await client.query(
        `INSERT INTO app_content (content_key, lang, title, body, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (content_key, lang)
         DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = NOW()`,
        [contentKey, lang, title, body]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getContentAll(contentKey);
}

/* ===================== Sirups ===================== */

async function listSirups(langInput) {
  const want = normalizeLang(langInput);
  const { rows: sirups } = await pool.query(
    `SELECT id, order_index FROM sirups ORDER BY order_index ASC`
  );
  if (sirups.length === 0) return [];
  const ids = sirups.map((s) => s.id);
  const { rows: trs } = await pool.query(
    `SELECT sirup_id, lang, title, description FROM sirup_translations WHERE sirup_id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map();
  for (const t of trs) {
    if (!byId.has(t.sirup_id)) byId.set(t.sirup_id, {});
    byId.get(t.sirup_id)[t.lang] = { title: t.title, description: t.description };
  }
  const resolve = (map) => {
    if (!map) return { title: '', description: '' };
    if (map[want]) return map[want];
    for (const l of SUPPORTED_LANGS) if (map[l]) return map[l];
    const k = Object.keys(map); return k.length ? map[k[0]] : { title: '', description: '' };
  };
  return sirups.map((s) => {
    const r = resolve(byId.get(s.id));
    return { id: s.id, orderIndex: s.order_index, title: r.title || '', description: r.description || '' };
  });
}

async function listSirupsFull() {
  const { rows: sirups } = await pool.query(
    `SELECT id, order_index FROM sirups ORDER BY order_index ASC`
  );
  const ids = sirups.map((s) => s.id);
  const byId = new Map();
  if (ids.length) {
    const { rows: trs } = await pool.query(
      `SELECT sirup_id, lang, title, description FROM sirup_translations WHERE sirup_id = ANY($1::int[])`,
      [ids]
    );
    for (const t of trs) {
      if (!byId.has(t.sirup_id)) byId.set(t.sirup_id, {});
      byId.get(t.sirup_id)[t.lang] = { title: t.title, description: t.description };
    }
  }
  return sirups.map((s) => ({ id: s.id, orderIndex: s.order_index, translations: byId.get(s.id) || {} }));
}

function normTranslations(translations) {
  if (!translations || typeof translations !== 'object' || Object.keys(translations).length === 0) {
    throw new HttpError(400, 'translations are required');
  }
  const out = {};
  for (const [rawLang, val] of Object.entries(translations)) {
    if (!isSupported(rawLang)) continue;
    const title = val && val.title != null ? String(val.title).trim().slice(0, 255) : '';
    if (title.length === 0) continue; // a language needs a title to be stored
    const description = val && val.description != null ? String(val.description).slice(0, 5000) : null;
    out[rawLang.toLowerCase()] = { title, description };
  }
  if (Object.keys(out).length === 0) throw new HttpError(400, 'at least one language title is required');
  return out;
}

async function createSirup(payload) {
  const trs = normTranslations(payload && payload.translations);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query(`SELECT COALESCE(MAX(order_index), 0) AS m FROM sirups`);
    const orderIndex = Number(maxRows[0].m) + 1;
    const { rows } = await client.query(
      `INSERT INTO sirups (order_index) VALUES ($1) RETURNING id, order_index`,
      [orderIndex]
    );
    const sirup = rows[0];
    for (const [lang, val] of Object.entries(trs)) {
      await client.query(
        `INSERT INTO sirup_translations (sirup_id, lang, title, description) VALUES ($1, $2, $3, $4)`,
        [sirup.id, lang, val.title, val.description]
      );
    }
    await client.query('COMMIT');
    return { id: sirup.id, orderIndex: sirup.order_index, translations: trs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateSirup(sirupId, payload) {
  const id = Number(sirupId);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'invalid sirup id');
  const trs = normTranslations(payload && payload.translations);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id FROM sirups WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Sirup not found');
    await client.query(`DELETE FROM sirup_translations WHERE sirup_id = $1`, [id]);
    for (const [lang, val] of Object.entries(trs)) {
      await client.query(
        `INSERT INTO sirup_translations (sirup_id, lang, title, description) VALUES ($1, $2, $3, $4)`,
        [id, lang, val.title, val.description]
      );
    }
    await client.query('COMMIT');
    return { id, translations: trs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteSirup(sirupId) {
  const id = Number(sirupId);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'invalid sirup id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT id FROM sirups ORDER BY order_index ASC FOR UPDATE`
    );
    if (!existing.some((r) => r.id === id)) throw new HttpError(404, 'Sirup not found');
    await client.query(`DELETE FROM sirups WHERE id = $1`, [id]); // cascades translations
    // Renumber survivors 1..N (offset two-pass to avoid unique collisions).
    const survivors = existing.filter((r) => r.id !== id).map((r) => r.id);
    await client.query(`UPDATE sirups SET order_index = order_index + 100000`);
    for (let i = 0; i < survivors.length; i++) {
      await client.query(`UPDATE sirups SET order_index = $2 WHERE id = $1`, [survivors[i], i + 1]);
    }
    await client.query('COMMIT');
    return { ok: true, deletedId: id, remaining: survivors.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getContent, getContentAll, setContent,
  listSirups, listSirupsFull, createSirup, updateSirup, deleteSirup,
};
