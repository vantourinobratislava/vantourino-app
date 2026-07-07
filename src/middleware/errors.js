'use strict';

function notFound(req, res, next) {
  res.status(404).json({ error: 'Not Found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  const message = err.expose
    ? err.message
    : (status >= 500 ? 'Internal Server Error' : (err.message || 'Error'));
  res.status(status).json({ error: message });
}

module.exports = { notFound, errorHandler };
