'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/*
 * Storage abstraction for audio files.
 *
 * Files live on a durable filesystem path (AUDIO_DIR). In production this MUST
 * be a mounted persistent volume (e.g. Railway volume at /data/audio) or files
 * vanish on redeploy. In development it falls back to a local folder under the
 * project. The DB stores only a `storage_key`; resolveStoragePath maps that to
 * an absolute path. To move to S3/R2 later, only this module changes.
 */

const DEFAULT_DEV_DIR = path.join(__dirname, '..', '..', 'var', 'audio');

function audioDir() {
  const dir = process.env.AUDIO_DIR && process.env.AUDIO_DIR.trim().length
    ? process.env.AUDIO_DIR.trim()
    : DEFAULT_DEV_DIR;
  return dir;
}

function ensureAudioDir() {
  const dir = audioDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const EXT_BY_MIME = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/oga': '.oga',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
};

function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(EXT_BY_MIME, (mime || '').toLowerCase());
}

/** Pick a safe extension from mime, falling back to a sanitized original ext. */
function extFor(mime, originalName) {
  const m = (mime || '').toLowerCase();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const oe = path.extname(originalName || '').toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(oe)) return oe;
  return '.bin';
}

/** Generate a random, collision-resistant storage key. Never uses user input. */
function generateStorageKey(mime, originalName) {
  const rand = crypto.randomBytes(16).toString('hex');
  return `aud_${Date.now().toString(36)}_${rand}${extFor(mime, originalName)}`;
}

/** Absolute path for a storage key. Guards against path traversal. */
function resolveStoragePath(storageKey) {
  const safe = path.basename(storageKey || ''); // strip any path components
  if (!safe || safe !== storageKey) {
    throw new Error('invalid storage key');
  }
  return path.join(audioDir(), safe);
}

module.exports = {
  audioDir,
  ensureAudioDir,
  isAllowedMime,
  generateStorageKey,
  resolveStoragePath,
  EXT_BY_MIME,
};
