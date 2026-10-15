/** An error to show the user. `status` follows HTTP meanings (404, 409, 422, 503...). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public retryAfter?: number | null,
  ) {
    super(message)
  }
}

/** A business-rule violation (was HTTP 409 on the server). */
export class LifecycleError extends ApiError {
  constructor(message: string, code = 'conflict') {
    super(409, message, code)
  }
}

export const notFound = (what: string) => new ApiError(404, `${what} not found`, 'not_found')
export const invalid = (message: string) => new ApiError(422, message, 'invalid')
