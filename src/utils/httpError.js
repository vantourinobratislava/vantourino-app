'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true; // message is safe to send to client
  }
}

module.exports = HttpError;
