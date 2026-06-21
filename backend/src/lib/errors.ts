import { Prisma } from '@prisma/client';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

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

export function rethrowMapped(err: unknown): never {
  const mapped = mapPrismaError(err);
  if (mapped) throw mapped;
  throw err;
}
