import { withTenant } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, rethrowMapped } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';

// All functions here use withTenant() which automatically:
//  - Scopes every DB query to the logged-in creator via Postgres Row Level Security (RLS)
//  - Wraps everything in a transaction (so audit log writes are atomic with data writes)
// No function needs to manually filter by creatorId — RLS enforces it at the DB level.

// Returns all programs for the current user, newest first.
// withTenant handles the "only show this user's programs" filtering via RLS.
export async function listPrograms() {
  return withTenant((tx) =>
    tx.program.findMany({ orderBy: { createdAt: 'desc' } }),
  );
}

// Fetches a single program by ID.
// Because withTenant sets the RLS tenant, Postgres will return no rows if the ID belongs
// to a different user — so the 404 covers both "doesn't exist" and "not yours".
export async function getProgram(id: string) {
  return withTenant(async (tx) => {
    const program = await tx.program.findUnique({ where: { id } });
    if (!program) throw new AppError('Program not found', 404);
    return program;
  });
}

// Creates a new program for the current user.
// Enforces a per-creator program limit (from config) to prevent abuse.
// getContext() reads tenantId from AsyncLocalStorage — set by auth middleware earlier in the request.
export async function createProgram(data: {
  title: string;
  description?: string;
  tags: string[];
}) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    // count() inside withTenant is already scoped to this user's programs via RLS.
    const count = await tx.program.count();
    if (count >= config.MAX_PROGRAMS_PER_CREATOR) {
      throw new AppError(`Cannot exceed ${config.MAX_PROGRAMS_PER_CREATOR} programs`, 422);
    }

    // rethrowMapped converts Prisma unique-constraint errors into friendly AppErrors
    // (e.g. duplicate title) instead of leaking raw DB error messages to the client.
    const program = await tx.program
      .create({ data: { ...data, creatorId: tenantId } })
      .catch(rethrowMapped);

    // Audit log is written inside the same transaction — if the program.create fails and
    // the transaction rolls back, the audit entry is also rolled back (no phantom log entries).
    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'program.create',
      targetType: 'program',
      targetId: program.id,
    });

    return program;
  });
}

// Updates a program's fields (title, description, tags).
// Uses updateMany with { id, creatorId } so the update silently does nothing if the
// program belongs to a different user — then the count === 0 check returns a 404.
// This avoids leaking whether a program ID exists for another user.
export async function updateProgram(
  id: string,
  data: { title?: string; description?: string; tags?: string[] },
) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const result = await tx.program
      .updateMany({ where: { id, creatorId: tenantId }, data })
      .catch(rethrowMapped);

    if (result.count === 0) throw new AppError('Program not found', 404);

    const updated = await tx.program.findUniqueOrThrow({ where: { id } });

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'program.update',
      targetType: 'program',
      targetId: id,
    });

    return updated;
  });
}

// Deletes a program. The DB schema cascades this to all child Sessions and Media records
// automatically (onDelete: Cascade in schema.prisma) so no manual cleanup is needed.
// Same updateMany pattern as above — count === 0 means not found or not owned by this user.
export async function deleteProgram(id: string) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const result = await tx.program
      .deleteMany({ where: { id, creatorId: tenantId } })
      .catch(rethrowMapped);

    if (result.count === 0) throw new AppError('Program not found', 404);

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'program.delete',
      targetType: 'program',
      targetId: id,
    });
  });
}
