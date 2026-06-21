import { withTenant } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, rethrowMapped } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';

export async function listSessions(programId: string) {
  return withTenant((tx) =>
    tx.session.findMany({
      where: { programId },
      orderBy: { position: 'asc' },
    }),
  );
}

export async function getSession(id: string) {
  return withTenant(async (tx) => {
    const session = await tx.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', 404);
    return session;
  });
}

export async function createSession(
  programId: string,
  data: { title: string; description?: string; instructorName?: string; tags?: string[]; durationSeconds: number },
) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const program = await tx.program.findUnique({ where: { id: programId } });
    if (!program) throw new AppError('Program not found', 404);

    const count = await tx.session.count({ where: { programId } });
    if (count >= config.MAX_SESSIONS_PER_PROGRAM) {
      throw new AppError(`Cannot exceed ${config.MAX_SESSIONS_PER_PROGRAM} sessions`, 422);
    }

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

export async function reorderSessions(programId: string, orderedIds: string[]) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    // Lock the program row to prevent concurrent reorder + import races
    const program = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM programs WHERE id = ${programId}::uuid AND creator_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    if (program.length === 0) throw new AppError('Program not found', 404);

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
