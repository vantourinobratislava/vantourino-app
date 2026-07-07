'use strict';

function required(name) {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const config = {
  NODE_ENV,
  IS_PROD,
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // DATABASE_URL is required in production; optional in dev so the app
  // can boot for non-DB endpoints (/, /health) without a Postgres handy.
  DATABASE_URL: IS_PROD ? required('DATABASE_URL') : process.env.DATABASE_URL,

  // SESSION_SECRET must be set in production. Dev fallback only.
  SESSION_SECRET: IS_PROD
    ? required('SESSION_SECRET')
    : (process.env.SESSION_SECRET || 'dev-insecure-secret-do-not-use-in-prod'),

  COOKIE_NAME: process.env.COOKIE_NAME || 'bbqa.sid',
  SESSION_TTL_MS: 1000 * 60 * 60 * 12, // 12 hours
};

module.exports = config;
