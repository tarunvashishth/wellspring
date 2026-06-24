import { Prisma } from '@prisma/client';

// AppError is our custom error class for all expected failures (bad input, not found, conflicts).
// Throwing an AppError anywhere in a service function causes the global error handler in app.ts
// to return a well-formed JSON response with the correct HTTP status code.
// Without this, we'd have to call res.status().json() everywhere — messy and easy to forget.
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number, // HTTP status (400, 401, 404, 409, 422...)
    public readonly code?: string,       // machine-readable code (e.g. 'NOT_FOUND', 'CONFLICT')
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Prisma throws its own error types with codes like P2002 (unique constraint violated).
// mapPrismaError converts them into AppErrors with friendly messages and correct HTTP statuses
// so the global error handler can handle them uniformly. Returns null for unknown Prisma errors.
//
// Common codes:
//   P2025 — record not found (e.g. update/delete on non-existent row)
//   P2002 — unique constraint violation (e.g. duplicate email on signup)
//   P2003 — foreign key constraint violation (e.g. referencing a non-existent program)
//   P2034 — write conflict / serialization failure (e.g. two transactions conflicting)
export function mapPrismaError(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (err.code) {
    case 'P2025': return new AppError('Resource not found', 404, 'NOT_FOUND');
    case 'P2002': return new AppError('Resource already exists', 409, 'CONFLICT');
    case 'P2003': return new AppError('Invalid reference', 400, 'BAD_REFERENCE');
    case 'P2034': return new AppError('Write conflict, please retry', 409, 'CONFLICT');
    default: return null;
  }
}

// Convenience wrapper used in .catch() chains on Prisma calls:
//   tx.program.create(...).catch(rethrowMapped)
// If the error is a known Prisma error → throws the mapped AppError.
// If not → re-throws the original error unchanged (so it still reaches the global handler).
export function rethrowMapped(err: unknown): never {
  const mapped = mapPrismaError(err);
  if (mapped) throw mapped;
  throw err;
}
