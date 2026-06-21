import { withTenant } from '../db/prismaWithTenant';
import { AppError } from '../lib/errors';

const MAX_RANGE_DAYS = 90;

export async function listAuditLogs(params: {
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  action?: string;
  targetType?: string;
  severity?: string;
}) {
  const limit = Math.min(params.limit ?? 50, 200);

  return withTenant(async (tx) => {
    const from = params.from ? new Date(params.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = params.to ? new Date(params.to) : new Date();

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new AppError('Invalid date range', 400);
    }
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new AppError(`Date range cannot exceed ${MAX_RANGE_DAYS} days`, 422);
    }

    const logs = await tx.auditLog.findMany({
      where: {
        ...(params.cursor ? { id: { lt: BigInt(params.cursor) } } : {}),
        createdAt: { gte: from, lte: to },
        ...(params.action ? { action: params.action } : {}),
        ...(params.targetType ? { targetType: params.targetType } : {}),
        ...(params.severity ? { severity: params.severity } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const hasMore = logs.length > limit;
    const items = hasMore ? logs.slice(0, limit) : logs;
    const nextCursor = hasMore ? items[items.length - 1].id.toString() : null;

    return {
      items: items.map((l) => ({ ...l, id: l.id.toString() })),
      nextCursor,
    };
  });
}
