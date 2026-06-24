import { withTenant } from '../db/prismaWithTenant';
import { AppError } from '../lib/errors';

const MAX_RANGE_DAYS = 90; // prevent queries that scan too much data at once

// Fetches audit logs with filtering and cursor-based pagination.
//
// Why cursor-based pagination instead of OFFSET/LIMIT pages?
//   OFFSET pagination has a problem: if new rows are inserted while you're browsing,
//   the pages shift. You might see the same row twice or skip rows.
//   Cursor pagination uses the last seen row's ID as a bookmark — "give me rows older than ID X".
//   IDs are auto-incrementing BigInts, so `id < cursor` reliably fetches the next page.
//
// Default date range is last 7 days to keep queries fast. Capped at 90 days to prevent
// very large scans on the audit_logs table.
export async function listAuditLogs(params: {
  cursor?: string;    // BigInt ID of the last item on the previous page
  limit?: number;     // how many items per page (max 200)
  from?: string;      // ISO date string e.g. "2026-01-01"
  to?: string;
  action?: string;    // filter by action e.g. "program.create"
  targetType?: string;
  severity?: string;
}) {
  // Clamp limit between 1 and 200 — prevents a client from requesting 10,000 rows at once.
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

    // Fetch limit + 1 rows — if we get more than limit back, there IS a next page.
    // We then return only `limit` rows to the client but use the extra row to know
    // whether to include a nextCursor. This avoids a separate COUNT query.
    const logs = await tx.auditLog.findMany({
      where: {
        // cursor: only return rows with id LESS THAN the cursor (older rows, since we sort desc)
        ...(params.cursor ? { id: { lt: BigInt(params.cursor) } } : {}),
        createdAt: { gte: from, lte: to },
        ...(params.action ? { action: params.action } : {}),
        ...(params.targetType ? { targetType: params.targetType } : {}),
        ...(params.severity ? { severity: params.severity } : {}),
      },
      orderBy: { id: 'desc' }, // newest first; BigInt IDs are monotonically increasing
      take: limit + 1,         // fetch one extra to detect if there's a next page
    });

    const hasMore = logs.length > limit;
    const items = hasMore ? logs.slice(0, limit) : logs; // trim the extra row before returning
    // The cursor for the next page is the ID of the LAST item in this page.
    const nextCursor = hasMore ? items[items.length - 1].id.toString() : null;

    return {
      // BigInt is not JSON-serializable — convert all IDs to strings before sending.
      items: items.map((l) => ({ ...l, id: l.id.toString() })),
      nextCursor, // null means no more pages
    };
  });
}
