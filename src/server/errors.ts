/** An error with a stable code and an HTTP status, safe to show to the person who caused it. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (message = 'Please sign in.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'invalid_request', message, details);
