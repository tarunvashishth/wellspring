import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { withTenant, withTenantForImport, TenantTx } from '../db/prismaWithTenant';
import { writeAudit } from '../lib/audit';
import { AppError, mapPrismaError } from '../lib/errors';
import { getContext } from '../lib/context';
import { config } from '../config';

// Thrown when a concurrent request wins the clientImportId UNIQUE race
class ConcurrentImportError extends Error {
  constructor(public readonly winnerImportId: string) {
    super('Concurrent import');
  }
}

const rowSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  duration_seconds: z
    .string()
    .regex(/^\d+$/, 'Must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(86_400)),
});

interface ParsedRow {
  rowNumber: number;
  data: z.infer<typeof rowSchema> | null;
  errors: { field: string; message: string }[];
  importKey: string;
}

function parseCSV(buffer: Buffer): ParsedRow[] {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((record, i) => {
    const rowNumber = i + 2; // 1-based, row 1 is header
    const result = rowSchema.safeParse(record);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'unknown',
        message: issue.message,
      }));
      return { rowNumber, data: null, errors, importKey: '' };
    }
    const importKey = createHash('sha256')
      .update(`${result.data.title}`)
      .digest('hex')
      .slice(0, 64);
    return { rowNumber, data: result.data, errors: [], importKey };
  });
}

async function resolveStartPosition(tx: TenantTx, programId: string): Promise<number> {
  // Lock program row to serialize concurrent imports + reorders
  const rows = await tx.$queryRaw<{ max_pos: number | null }[]>`
    SELECT MAX(s.position) AS max_pos
    FROM programs p
    LEFT JOIN sessions s ON s.program_id = p.id
    WHERE p.id = ${programId}::uuid
    FOR UPDATE OF p
  `;
  return (rows[0]?.max_pos ?? 0) + 1;
}

export async function startImport(
  programId: string,
  clientImportId: string,
  csvBuffer: Buffer,
) {
  const { tenantId } = getContext();

  // Check for existing completed/processing import with this clientImportId
  const existing = await prisma.bulkImport.findUnique({
    where: { clientImportId },
  });
  if (existing) {
    if (existing.status === 'COMPLETED' || existing.status === 'PARTIAL') {
      return { importId: existing.id, status: existing.status, idempotent: true };
    }
    // Stuck detection: reset PENDING or PROCESSING imports past threshold
    const now = Date.now();
    const isPendingStuck =
      existing.status === 'PENDING' &&
      now - existing.createdAt.getTime() > config.IMPORT_STUCK_PENDING_MS;
    const isProcessingStuck =
      existing.status === 'PROCESSING' &&
      now - existing.updatedAt.getTime() > config.IMPORT_STUCK_PROCESSING_MS;

    if (!isPendingStuck && !isProcessingStuck) {
      return { importId: existing.id, status: existing.status, idempotent: true };
    }
    // Allow re-run of stuck import (fall through to create new record)
  }

  const rows = parseCSV(csvBuffer);
  const validRows = rows.filter((r) => r.errors.length === 0 && r.data !== null);
  const invalidRows = rows.filter((r) => r.errors.length > 0);

  // Claim the import slot atomically
  let importId: string;
  try {
    await withTenant(async (tx) => {
      const program = await tx.program.findUnique({ where: { id: programId } });
      if (!program) throw new AppError('Program not found', 404);

      const imp = await tx.bulkImport.create({
        data: {
          creatorId: tenantId,
          programId,
          clientImportId,
          status: 'PROCESSING',
          totalRows: rows.length,
        },
      });
      importId = imp.id;
    });
  } catch (err) {
    const mapped = mapPrismaError(err);
    if (mapped?.statusCode === 409) {
      // Another request won the race — find the winner
      const winner = await prisma.bulkImport.findUnique({ where: { clientImportId } });
      if (winner) throw new ConcurrentImportError(winner.id);
    }
    throw err;
  }

  // Run the main import in a long transaction
  let successRows = 0;
  let failedRows = invalidRows.length;

  try {
    await withTenantForImport(async (tx) => {
      const startPos = await resolveStartPosition(tx, programId);

      // Pre-fetch existing import keys to identify true duplicates
      const existingKeys = await tx.session.findMany({
        where: {
          programId,
          importKey: { in: validRows.map((r) => r.importKey).filter(Boolean) },
        },
        select: { importKey: true },
      });
      const existingKeySet = new Set(existingKeys.map((s) => s.importKey));

      const newRows = validRows.filter((r) => !existingKeySet.has(r.importKey));
      const duplicateRows = validRows.filter((r) => existingKeySet.has(r.importKey));

      await tx.session.createMany({
        data: newRows.map((r, i) => ({
          programId,
          creatorId: tenantId,
          title: r.data!.title,
          description: r.data!.description,
          durationSeconds: r.data!.duration_seconds,
          position: startPos + i,
          importKey: r.importKey,
        })),
        skipDuplicates: false,
      });

      successRows = newRows.length + duplicateRows.length; // duplicates count as "already imported"
      failedRows = invalidRows.length;

      await tx.bulkImport.update({
        where: { id: importId! },
        data: {
          status: failedRows > 0 ? 'PARTIAL' : 'COMPLETED',
          successRows,
          failedRows,
        },
      });

      await writeAudit({
        tx,
        creatorId: tenantId,
        actorId: tenantId,
        action: 'import.complete',
        targetType: 'bulk_import',
        targetId: importId!,
        metadata: { successRows, failedRows, totalRows: rows.length },
      });
    });
  } catch (err) {
    await prisma.bulkImport
      .update({ where: { id: importId! }, data: { status: 'FAILED' } })
      .catch(() => null);
    throw err;
  }

  // Write row-level errors in a separate best-effort transaction
  if (invalidRows.length > 0) {
    try {
      await withTenant(async (tx) => {
        await tx.importError.createMany({
          data: invalidRows.flatMap((r) =>
            r.errors.map((e) => ({
              importId: importId!,
              creatorId: tenantId,
              rowNumber: r.rowNumber,
              field: e.field,
              message: e.message,
            })),
          ),
        });
      });
    } catch {
      // Best-effort — don't fail the import if error rows can't be written
    }
  }

  return {
    importId: importId!,
    status: failedRows > 0 ? 'PARTIAL' : 'COMPLETED',
    successRows,
    failedRows,
    totalRows: rows.length,
    idempotent: false,
  };
}

export async function getImport(importId: string) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const imp = await tx.bulkImport.findFirst({
      where: { id: importId, creatorId: tenantId },
      include: { errors: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!imp) throw new AppError('Import not found', 404);
    return imp;
  });
}
