// Build an Error tagged with an HTTP status code. Fastify (and our error
// handler) read `statusCode` to set the response status, so throwing one of
// these turns a handler failure into a proper 4xx/5xx instead of a bare 500.
const httpError = (statusCode: number, message: string): Error => {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
};

export default httpError;
