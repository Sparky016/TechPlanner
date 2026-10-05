// Server-only: never import from src/lib or client components.

// An error that maps directly onto an HTTP response. `code` is a stable machine-readable identifier.
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
