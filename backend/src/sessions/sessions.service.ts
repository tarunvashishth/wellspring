import { withTenant } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, rethrowMapped } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';

// Sessions are always ordered by the `position` integer field (1, 2, 3...).
// This allows drag-and-drop reordering without gaps or conflicts.

// Returns all sessions for a given program, sorted by position (ascending = display order).
export async function listSessions(programId: string) {
  return withTenant((tx) =>
    tx.session.findMany({
      where: { programId },
      orderBy: { position: 'asc' },
    }),
  );
}

// Fetches a single session. withTenant's RLS ensures this only returns sessions
// belonging to the current user's programs.
export async function getSession(id: string) {
  return withTenant(async (tx) => {
    const session = await tx.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', 404);
    return session;
  });
}

// Creates a new session at the end of the program's session list.
// Position is calculated by finding the current max position and adding 1 —
// so new sessions always appear last without needing to renumber existing ones.
export async function createSession(
  programId: string,
  data: { title: string; description?: string; instructorName?: string; tags?: string[]; durationSeconds: number },
) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    // Verify the parent program exists and belongs to this user (via RLS).
    const program = await tx.program.findUnique({ where: { id: programId } });
    if (!program) throw new AppError('Program not found', 404);

    // Enforce per-program session limit to prevent abuse.
    const count = await tx.session.count({ where: { programId } });
    if (count >= config.MAX_SESSIONS_PER_PROGRAM) {
      throw new AppError(`Cannot exceed ${config.MAX_SESSIONS_PER_PROGRAM} sessions`, 422);
    }

    // aggregate._max finds the highest position in use, then we place the new session after it.
    // If there are no sessions yet, _max.position is null, so ?? 0 gives position = 1.
    const maxPos = await tx.session.aggregate({
      where: { programId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? 0) + 1;

    const session = await tx.session
      .create({ data: { ...data, programId, creatorId: tenantId, position } })
      .catch(rethrowMapped);

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'session.create',
      targetType: 'session',
      targetId: session.id,
    });

    return session;
  });
}

// Partially updates a session's metadata. Same updateMany + count pattern as programs:
// ownership check and existence check in a single query.
export async function updateSession(
  id: string,
  data: { title?: string; description?: string; instructorName?: string; tags?: string[]; durationSeconds?: number },
) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const result = await tx.session
      .updateMany({ where: { id, creatorId: tenantId }, data })
      .catch(rethrowMapped);

    if (result.count === 0) throw new AppError('Session not found', 404);

    const updated = await tx.session.findUniqueOrThrow({ where: { id } });

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'session.update',
      targetType: 'session',
      targetId: id,
    });

    return updated;
  });
}

// Deletes a session. The DB cascades this to any associated Media records automatically.
export async function deleteSession(id: string) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const result = await tx.session
      .deleteMany({ where: { id, creatorId: tenantId } })
      .catch(rethrowMapped);

    if (result.count === 0) throw new AppError('Session not found', 404);

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'session.delete',
      targetType: 'session',
      targetId: id,
    });
  });
}

// Reorders sessions by accepting a full ordered list of session IDs.
// The client sends all IDs in the desired order; we assign position 1, 2, 3... accordingly.
//
// Key challenge: concurrent requests (e.g. two tabs reordering at the same time, or a bulk
// import adding sessions while a reorder is in flight) could corrupt positions.
// Solution: lock the program row with FOR UPDATE before reading positions — any concurrent
// transaction that also tries to lock that row will wait until this one commits or rolls back.
export async function reorderSessions(programId: string, orderedIds: string[]) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    // Lock the program row to prevent concurrent reorder + import races
    const program = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM programs WHERE id = ${programId}::uuid AND creator_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    if (program.length === 0) throw new AppError('Program not found', 404);

    // Validate that the client sent exactly the right set of IDs — no extras, no missing.
    // This prevents accidentally dropping sessions from a program.
    const existing = await tx.session.findMany({
      where: { programId, creatorId: tenantId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((s) => s.id));

    for (const id of orderedIds) {
      if (!existingIds.has(id)) throw new AppError(`Session ${id} not found`, 404);
    }
    if (orderedIds.length !== existingIds.size) {
      throw new AppError('orderedIds must contain all session IDs', 422);
    }

    // Update all positions in parallel (Promise.all) within the same transaction.
    // idx + 1 converts 0-based array index to 1-based position.
    await Promise.all(
      orderedIds.map((id, idx) =>
        tx.session.update({ where: { id }, data: { position: idx + 1 } }),
      ),
    );

    await writeAudit({
      tx,
      creatorId: tenantId,
      actorId: tenantId,
      action: 'session.reorder',
      targetType: 'program',
      targetId: programId,
      metadata: { sessionCount: orderedIds.length },
    });

    return tx.session.findMany({ where: { programId }, orderBy: { position: 'asc' } });
  });
}
