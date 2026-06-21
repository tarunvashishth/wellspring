import { withTenant } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, rethrowMapped } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';

export async function listPrograms() {
  return withTenant((tx) =>
    tx.program.findMany({ orderBy: { createdAt: 'desc' } }),
  );
}

export async function getProgram(id: string) {
  return withTenant(async (tx) => {
    const program = await tx.program.findUnique({ where: { id } });
    if (!program) throw new AppError('Program not found', 404);
    return program;
  });
}

export async function createProgram(data: {
  title: string;
  description?: string;
  tags: string[];
}) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const count = await tx.program.count();
    if (count >= config.MAX_PROGRAMS_PER_CREATOR) {
      throw new AppError(`Cannot exceed ${config.MAX_PROGRAMS_PER_CREATOR} programs`, 422);
    }

    const program = await tx.program
      .create({ data: { ...data, creatorId: tenantId } })
      .catch(rethrowMapped);

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
