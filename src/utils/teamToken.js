'use strict';

const crypto = require('crypto');

// 32 bytes → 64 hex chars. Plenty of entropy for an internal team token.
function generate() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generate };
