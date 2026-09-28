class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

module.exports = { HttpError, badRequest, notFound };
