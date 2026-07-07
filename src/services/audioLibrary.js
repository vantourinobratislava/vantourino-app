'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const pool = require('../db/pool');
const HttpError = require('../utils/httpError');
const storage = require('../utils/audioStorage');

/**
 * Probe duration (seconds) from an audio file. Best-effort: returns null on any
 * failure so an upload is never blocked by a probe error. Uses music-metadata
 * (pure JS, no native deps); loaded lazily so the service still works if the
 * dep is somehow absent.
 */
async function probeDurationSeconds(absPath) {
  try {
    const mm = require('music-metadata');
    const meta = await mm.parseFile(absPath, { duration: true });
    const d = meta && meta.format && meta.format.duration;
    if (typeof d === 'number' && isFinite(d) && d > 0) return Math.round(d);
    return null;
  } catch (_err) {
    return null;
  }
}

function cleanTitle(input, fallback) {
  const t = (input == null ? '' : String(input)).trim();
  if (t.length === 0) return (fallback || 'Untitled').slice(0, 255);
  return t.slice(0, 255);
}

function rowToDto(r) {
  return {
    id: r.id,
    title: r.title,
    originalName: r.original_name || null,
    mime: r.mime,
    byteSize: Number(r.byte_size) || 0,
    durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    createdAt: r.created_at,
    guideId: r.guide_id == null ? null : Number(r.guide_id),
    lang: r.lang || null,
  };
}

/**
 * Best-effort filesystem health check for a recording row. Returns 'ok' when
 * the storage file is accessible, 'missing' otherwise (ENOENT, permissions,
 * AUDIO_DIR misconfig, etc — admin doesn't need the distinction).
 * Never throws; designed to be called in parallel for a whole listing.
 */
async function statFor(storageKey) {
  if (!storageKey) return 'missing';
  try {
    const abs = storage.resolveStoragePath(storageKey);
    await fsp.stat(abs);
    return 'ok';
  } catch (_err) {
    return 'missing';
  }
}

/** Decorate a DTO with the on-disk health status. */
function withFileStatus(dto, status) {
  return { ...dto, fileStatus: status };
}

/**
 * Create a recording from an uploaded file already written to disk by multer
 * (file = { path, originalname, mimetype, size }). Moves/keeps it under
 * AUDIO_DIR with a generated storage_key, probes duration, inserts metadata.
 * On any DB failure the stored file is cleaned up.
 */
async function createFromUpload(file, titleInput) {
  if (!file) throw new HttpError(400, 'no file uploaded');
  if (!storage.isAllowedMime(file.mimetype)) {
    // clean the temp file multer wrote
    await fsp.unlink(file.path).catch(() => {});
    throw new HttpError(415, 'unsupported audio type');
  }

  storage.ensureAudioDir();
  const storageKey = storage.generateStorageKey(file.mimetype, file.originalname);
  const destPath = storage.resolveStoragePath(storageKey);

  // Move temp upload into place (rename within same fs; fall back to copy).
  try {
    await fsp.rename(file.path, destPath);
  } catch (_err) {
    await fsp.copyFile(file.path, destPath);
    await fsp.unlink(file.path).catch(() => {});
  }

  const duration = await probeDurationSeconds(destPath);
  const title = cleanTitle(titleInput, baseName(file.originalname));

  try {
    const { rows } = await pool.query(
      `INSERT INTO audio_recordings (title, original_name, storage_key, mime, byte_size, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang`,
      [title, file.originalname || null, storageKey, file.mimetype, file.size || 0, duration]
    );
    return rowToDto(rows[0]);
  } catch (err) {
    await fsp.unlink(destPath).catch(() => {});
    throw err;
  }
}

function baseName(name) {
  const n = (name || '').replace(/\.[^.]+$/, '');
  return n.length ? n : 'Untitled';
}

async function list() {
  const { rows } = await pool.query(
    `SELECT id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang
       FROM audio_recordings ORDER BY created_at DESC, id DESC`
  );
  // Parallel filesystem health check so the admin sees broken rows without
  // pressing play. Cheap per-row; bounded by library size.
  const statuses = await Promise.all(rows.map((r) => statFor(r.storage_key)));
  return rows.map((r, i) => withFileStatus(rowToDto(r), statuses[i]));
}

/** Internal: fetch raw row incl. storage_key (for streaming/deleting). */
async function getRaw(id) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  const { rows } = await pool.query(
    `SELECT id, title, storage_key, mime, byte_size, duration_seconds, guide_id, lang FROM audio_recordings WHERE id = $1`,
    [rid]
  );
  if (!rows[0]) throw new HttpError(404, 'recording not found');
  return rows[0];
}

async function rename(id, titleInput) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  const title = cleanTitle(titleInput, null);
  if (!title || title === 'Untitled') {
    if (titleInput == null || String(titleInput).trim().length === 0) {
      throw new HttpError(400, 'title is required');
    }
  }
  const { rows } = await pool.query(
    `UPDATE audio_recordings SET title = $2 WHERE id = $1
     RETURNING id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang`,
    [rid, title]
  );
  if (!rows[0]) throw new HttpError(404, 'recording not found');
  return rowToDto(rows[0]);
}

async function remove(id) {
  const raw = await getRaw(id);
  // Remove DB row first; then best-effort delete the file.
  await pool.query(`DELETE FROM audio_recordings WHERE id = $1`, [raw.id]);
  try {
    const abs = storage.resolveStoragePath(raw.storage_key);
    await fsp.unlink(abs).catch(() => {});
  } catch (_err) { /* ignore */ }
  return { ok: true, deletedId: raw.id };
}

/**
 * Replace the underlying file for an existing recording row, preserving its
 * id, title, guide attachment, and language assignment. Useful when a
 * recording's storage file is missing or out of date — admin can re-upload
 * without losing identity.
 *
 * Safety order:
 *   1. Move the new upload into AUDIO_DIR under a FRESH storage_key (no
 *      overwrite — if any step fails the original file/row is untouched).
 *   2. Probe duration of the new file (best-effort).
 *   3. Single UPDATE swaps storage_key + mime + byte_size + duration +
 *      original_name. guide_id, lang, title are NOT touched.
 *   4. Best-effort unlink of the OLD file (no-op if it was already missing).
 *
 * On any failure before the UPDATE, the just-stored new file is cleaned up.
 */
async function replaceFile(id, file) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid id');
  if (!file) throw new HttpError(400, 'no file uploaded');
  if (!storage.isAllowedMime(file.mimetype)) {
    await fsp.unlink(file.path).catch(() => {});
    throw new HttpError(415, 'unsupported audio type');
  }

  // Row must exist.
  const existing = await getRaw(rid); // throws 404 if missing

  storage.ensureAudioDir();
  const newKey = storage.generateStorageKey(file.mimetype, file.originalname);
  const newPath = storage.resolveStoragePath(newKey);

  // Move temp upload into place.
  try {
    await fsp.rename(file.path, newPath);
  } catch (_err) {
    await fsp.copyFile(file.path, newPath);
    await fsp.unlink(file.path).catch(() => {});
  }

  const duration = await probeDurationSeconds(newPath);

  try {
    const { rows } = await pool.query(
      `UPDATE audio_recordings
          SET storage_key      = $2,
              mime             = $3,
              byte_size        = $4,
              duration_seconds = $5,
              original_name    = $6
        WHERE id = $1
       RETURNING id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang`,
      [rid, newKey, file.mimetype, file.size || 0, duration, file.originalname || null]
    );
    // Old file: best-effort cleanup. If it was already missing, this is a no-op.
    if (existing.storage_key && existing.storage_key !== newKey) {
      try {
        const oldAbs = storage.resolveStoragePath(existing.storage_key);
        await fsp.unlink(oldAbs).catch(() => {});
      } catch (_err) { /* ignore */ }
    }
    return withFileStatus(rowToDto(rows[0]), 'ok');
  } catch (err) {
    // UPDATE failed somehow — clean up the just-stored new file so we don't
    // orphan it; original row + file remain untouched.
    await fsp.unlink(newPath).catch(() => {});
    throw err;
  }
}

/**
 * Stream a recording with HTTP Range support (so <audio> seeking works).
 * Writes directly to the Express res.
 */
async function stream(id, req, res) {
  const raw = await getRaw(id); // throws 404 'recording not found' if no row

  let abs;
  try {
    abs = storage.resolveStoragePath(raw.storage_key);
  } catch (err) {
    // storage_key was malformed somehow — treat as missing file, but make the
    // cause visible in the logs so an admin can fix the data.
    console.error(`[audio] invalid storage_key for recording id=${raw.id}: ${err.message}`);
    throw new HttpError(404, 'audio file not found (invalid storage key)');
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (_err) {
    // The DB row exists but the file is not on disk at AUDIO_DIR. This is
    // almost always a deployment problem (missing persistent volume, AUDIO_DIR
    // changed between deploys). Log enough to diagnose; tell clients clearly.
    console.error(
      `[audio] file missing for recording id=${raw.id} (storage_key=${raw.storage_key}). ` +
      `Tried path: ${abs}. AUDIO_DIR=${storage.audioDir()}. ` +
      `If this is production, ensure AUDIO_DIR points at a mounted persistent volume.`
    );
    throw new HttpError(404, 'audio file not found on disk (AUDIO_DIR may be misconfigured)');
  }
  const total = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', raw.mime || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? 0 : parseInt(m[1], 10);
      let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
      if (isNaN(start) || isNaN(end) || start > end || start < 0 || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
  }

  res.status(200);
  res.setHeader('Content-Length', total);
  return fs.createReadStream(abs).pipe(res);
}

/* ===================== Audioguides B2.1: guides + variants ===================== */

// 6 supported audio languages — kept locally so the audio module isn't coupled
// to the UI language list (which is a different concern).
const SUPPORTED_AUDIO_LANGS = ['en', 'de', 'sk', 'it', 'es', 'fr'];

function isSupportedAudioLang(lang) {
  return typeof lang === 'string' && SUPPORTED_AUDIO_LANGS.includes(lang.toLowerCase());
}

function guideRowToDto(g, variants) {
  return {
    id: g.id,
    title: g.title,
    description: g.description || null,
    createdAt: g.created_at,
    variants: variants || [],
    languageCoverage: (variants || []).map((v) => v.lang).filter(Boolean),
  };
}

async function createGuide({ title, description } = {}) {
  const t = cleanTitle(title, null);
  if (!t || t === 'Untitled') {
    if (!title || String(title).trim().length === 0) {
      throw new HttpError(400, 'title is required');
    }
  }
  const desc = description == null ? null : String(description).slice(0, 5000);
  const { rows } = await pool.query(
    `INSERT INTO audio_guides (title, description) VALUES ($1, $2)
     RETURNING id, title, description, created_at`,
    [t, desc]
  );
  return guideRowToDto(rows[0], []);
}

async function listGuides() {
  const { rows: guides } = await pool.query(
    `SELECT id, title, description, created_at FROM audio_guides ORDER BY created_at DESC, id DESC`
  );
  if (guides.length === 0) return [];
  const ids = guides.map((g) => g.id);
  const { rows: vars } = await pool.query(
    `SELECT id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang
       FROM audio_recordings
      WHERE guide_id = ANY($1::int[])
      ORDER BY lang ASC, id ASC`,
    [ids]
  );
  // Variants carry the same fileStatus so the guide row's coverage chips can
  // distinguish present / missing / not-attached. Parallelized.
  const statuses = await Promise.all(vars.map((v) => statFor(v.storage_key)));
  const byGuide = new Map();
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    if (!byGuide.has(v.guide_id)) byGuide.set(v.guide_id, []);
    byGuide.get(v.guide_id).push(withFileStatus(rowToDto(v), statuses[i]));
  }
  return guides.map((g) => guideRowToDto(g, byGuide.get(g.id) || []));
}

async function renameGuide(id, { title, description } = {}) {
  const gid = Number(id);
  if (!Number.isInteger(gid) || gid < 1) throw new HttpError(400, 'invalid guide id');
  const sets = [];
  const params = [gid];
  if (title !== undefined) {
    const t = cleanTitle(title, null);
    if (!t || (title != null && String(title).trim().length === 0)) {
      throw new HttpError(400, 'title is required');
    }
    params.push(t); sets.push(`title = $${params.length}`);
  }
  if (description !== undefined) {
    const d = description == null ? null : String(description).slice(0, 5000);
    params.push(d); sets.push(`description = $${params.length}`);
  }
  if (sets.length === 0) throw new HttpError(400, 'nothing to update');
  const { rows } = await pool.query(
    `UPDATE audio_guides SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, title, description, created_at`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'guide not found');
  // refetch variants for the DTO
  const { rows: vars } = await pool.query(
    `SELECT id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang
       FROM audio_recordings WHERE guide_id = $1 ORDER BY lang ASC, id ASC`,
    [gid]
  );
  return guideRowToDto(rows[0], vars.map(rowToDto));
}

/**
 * Delete a guide. Variants attached to it cascade via ON DELETE on guide_id:
 * actually we used ON DELETE SET NULL on guide_id so the recordings survive
 * (their files stay on disk and they become standalone). This means deleting
 * a guide never deletes any files — admins clean up unwanted recordings
 * explicitly. AUDIO question references (added in B2.2) also SET NULL.
 */
async function deleteGuide(id) {
  const gid = Number(id);
  if (!Number.isInteger(gid) || gid < 1) throw new HttpError(400, 'invalid guide id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Null the lang on its variants first; ON DELETE SET NULL on guide_id
    // then handles the rest, leaving each former variant as a clean
    // standalone recording (guide_id NULL, lang NULL).
    await client.query(`UPDATE audio_recordings SET lang = NULL WHERE guide_id = $1`, [gid]);
    const { rows } = await client.query(`DELETE FROM audio_guides WHERE id = $1 RETURNING id`, [gid]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new HttpError(404, 'guide not found');
    }
    await client.query('COMMIT');
    return { ok: true, deletedId: gid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Attach an existing recording to a guide at a given language slot. If a
 * recording is already at (guide, lang), it must be detached first — the
 * partial unique index enforces this, so a clean 409 is returned.
 */
async function attachRecordingToGuide({ recordingId, guideId, lang }) {
  const rid = Number(recordingId);
  const gid = Number(guideId);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid recording id');
  if (!Number.isInteger(gid) || gid < 1) throw new HttpError(400, 'invalid guide id');
  if (!isSupportedAudioLang(lang)) throw new HttpError(400, 'unsupported language');
  const ln = lang.toLowerCase();

  // Guide must exist.
  const g = await pool.query(`SELECT id FROM audio_guides WHERE id = $1`, [gid]);
  if (!g.rows[0]) throw new HttpError(404, 'guide not found');

  // Recording must exist.
  const r = await pool.query(`SELECT id FROM audio_recordings WHERE id = $1`, [rid]);
  if (!r.rows[0]) throw new HttpError(404, 'recording not found');

  try {
    const { rows } = await pool.query(
      `UPDATE audio_recordings SET guide_id = $2, lang = $3 WHERE id = $1
       RETURNING id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang`,
      [rid, gid, ln]
    );
    return rowToDto(rows[0]);
  } catch (err) {
    // Unique-index violation on (guide_id, lang)
    if (err && err.code === '23505') {
      throw new HttpError(409, 'this guide already has a recording for that language');
    }
    throw err;
  }
}

async function detachRecordingFromGuide(recordingId) {
  const rid = Number(recordingId);
  if (!Number.isInteger(rid) || rid < 1) throw new HttpError(400, 'invalid recording id');
  const { rows } = await pool.query(
    `UPDATE audio_recordings SET guide_id = NULL, lang = NULL WHERE id = $1
     RETURNING id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang`,
    [rid]
  );
  if (!rows[0]) throw new HttpError(404, 'recording not found');
  return rowToDto(rows[0]);
}

/**
 * List the language codes that have an attached variant for a given guide,
 * ordered by lang ASC. Used by the admin live language switcher (B2.3) to
 * render only chips for languages the guide actually has. Returns [] for an
 * unknown or empty guide.
 */
async function listVariantLangs(guideId) {
  const gid = Number(guideId);
  if (!Number.isInteger(gid) || gid < 1) return [];
  const { rows } = await pool.query(
    `SELECT lang FROM audio_recordings
       WHERE guide_id = $1 AND lang IS NOT NULL
       ORDER BY lang ASC`,
    [gid]
  );
  return rows.map((r) => r.lang);
}

/**
 * Resolve the best variant for (guideId, requestedLang). Returns:
 *   { variant, usedLang, fellBack: bool }  or  null if the guide has no
 * variants at all.  Used by B2.2 live playback.
 */
async function resolveVariant(guideId, requestedLang) {
  const gid = Number(guideId);
  if (!Number.isInteger(gid) || gid < 1) return null;
  const { rows } = await pool.query(
    `SELECT id, title, original_name, storage_key, mime, byte_size, duration_seconds, created_at, guide_id, lang
       FROM audio_recordings WHERE guide_id = $1 ORDER BY lang ASC, id ASC`,
    [gid]
  );
  if (rows.length === 0) return null;
  const want = (requestedLang || '').toLowerCase();
  const hit = rows.find((v) => v.lang === want);
  if (hit) return { variant: rowToDto(hit), usedLang: hit.lang, fellBack: false };
  // Fallback: en first, then first available.
  const en = rows.find((v) => v.lang === 'en');
  const pick = en || rows[0];
  return { variant: rowToDto(pick), usedLang: pick.lang, fellBack: true };
}

module.exports = {
  // B1
  createFromUpload,
  list,
  rename,
  remove,
  stream,
  getRaw,
  replaceFile,
  // B2.1 guides + variants
  SUPPORTED_AUDIO_LANGS,
  isSupportedAudioLang,
  createGuide,
  listGuides,
  renameGuide,
  deleteGuide,
  attachRecordingToGuide,
  detachRecordingFromGuide,
  resolveVariant,
  listVariantLangs,
};
