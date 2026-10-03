/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new HttpError(400, code, message);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Upload not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooLarge = (message: string) => new HttpError(413, 'too_large', message);
export const tooManyRequests = (retryAfter = 60) =>
  new HttpError(429, 'rate_limited', 'Too many requests, please slow down', {
    'Retry-After': String(retryAfter),
  });
