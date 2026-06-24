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

// Zod schema for a single CSV row. All CSV values come in as strings, so numeric fields
// use .transform(Number) to convert after validating the format with a regex.
// duration_seconds max of 86,400 = 24 hours in seconds.
const rowSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  instructor_name: z.string().max(255).optional(),
  // tags column is a comma-separated string like "yoga,beginner" — split and trim each tag.
  tags: z.string().optional().transform((v) =>
    v ? v.split(',').map((t) => t.trim()).filter(Boolean) : []
  ),
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
  importKey: string;  // SHA-256 hash of the title, used for idempotency/duplicate detection
}

// Parses the CSV buffer into an array of ParsedRow objects.
// Uses safeParse (doesn't throw) so a bad row is captured as errors[], not a crash.
// rowNumber is 1-based matching spreadsheet row numbers (row 1 = header, row 2 = first data row).
function parseCSV(buffer: Buffer): ParsedRow[] {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,         // use first row as column names
    skip_empty_lines: true,
    trim: true,            // strip whitespace from values
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
    // importKey is a content-based hash of the title.
    // If the same CSV is uploaded twice, rows with the same title hash are treated as duplicates
    // and skipped rather than creating duplicate sessions.
    const importKey = createHash('sha256')
      .update(`${result.data.title}`)
      .digest('hex')
      .slice(0, 64);
    return { rowNumber, data: result.data, errors: [], importKey };
  });
}

// Determines what position number the first new session in this import should get.
// Locks the program row with FOR UPDATE to prevent a concurrent reorder or another import
// from grabbing the same position numbers while this import is running.
async function resolveStartPosition(tx: TenantTx, programId: string): Promise<number> {
  // Lock program row to serialize concurrent imports + reorders.
  // FOR UPDATE cannot be combined with aggregates, so we lock first then aggregate.
  await tx.$executeRaw`SELECT id FROM programs WHERE id = ${programId}::uuid FOR UPDATE`;
  const rows = await tx.$queryRaw<{ max_pos: number | null }[]>`
    SELECT MAX(position) AS max_pos FROM sessions WHERE program_id = ${programId}::uuid
  `;
  return (rows[0]?.max_pos ?? 0) + 1;
}

// Main import function — parses a CSV and bulk-creates sessions in a program.
//
// Key design decisions:
//  1. Idempotency: clientImportId is a UUID the client generates and sends with every attempt.
//     If the same clientImportId is submitted again, the server returns the original result
//     without re-running the import. Handles browser retries and network failures safely.
//  2. Stuck detection: if a previous import with this ID is stuck (no progress for too long),
//     we allow a fresh attempt rather than returning the stuck status forever.
//  3. Row-level errors: invalid rows are collected and reported back; valid rows are still imported.
//     This gives the user a PARTIAL status with a list of which rows failed and why.
//  4. Duplicate skipping: rows whose importKey (title hash) already exist in the program
//     are counted as successes without re-inserting, supporting re-upload of corrected CSVs.
//  5. Concurrency safety: the bulkImport record is created atomically using a UNIQUE constraint
//     on clientImportId — only one request can "win" even if two requests arrive simultaneously.
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
    // Already done — return the original result (idempotent response).
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

  // Claim the import slot atomically — bulkImport has UNIQUE(clientImportId) in the DB.
  // If two requests arrive simultaneously, only one succeeds; the other gets a 409 conflict.
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

  // Run the main import in a long transaction (withTenantForImport has longer timeouts).
  let successRows = 0;
  let failedRows = invalidRows.length;

  try {
    await withTenantForImport(async (tx) => {
      // Lock the program and get the starting position for new sessions.
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

      // Split valid rows into truly new ones vs already-imported duplicates.
      const newRows = validRows.filter((r) => !existingKeySet.has(r.importKey));
      const duplicateRows = validRows.filter((r) => existingKeySet.has(r.importKey));

      // createMany inserts all new sessions in a single DB statement — much faster than
      // individual create() calls in a loop (avoids N round-trips to the DB).
      await tx.session.createMany({
        data: newRows.map((r, i) => ({
          programId,
          creatorId: tenantId,
          title: r.data!.title,
          description: r.data!.description,
          instructorName: r.data!.instructor_name,
          tags: r.data!.tags ?? [],
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
          // PARTIAL if some rows had validation errors; COMPLETED if all rows succeeded.
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
    // If the transaction throws (e.g. DB error, timeout), mark the import as FAILED.
    // .catch(() => null) swallows any error from the update itself — we still want to
    // rethrow the original error so the client gets a proper error response.
    await prisma.bulkImport
      .update({ where: { id: importId! }, data: { status: 'FAILED' } })
      .catch(() => null);
    throw err;
  }

  // Write row-level errors in a separate best-effort transaction.
  // This is intentionally outside the main transaction — the sessions were already saved
  // successfully; if we can't save the error details, it's not worth rolling back the whole import.
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
    errors: invalidRows.flatMap((r) =>
      r.errors.map((e) => ({ rowNumber: r.rowNumber, field: e.field, message: e.message, rawData: null }))
    ),
    idempotent: false,
  };
}

// Fetches the status and row-level errors for a previously submitted import.
// BigInt IDs from the ImportError table are converted to strings because JSON.stringify
// can't serialize BigInt natively (it throws a TypeError).
export async function getImport(importId: string) {
  const { tenantId } = getContext();
  return withTenant(async (tx) => {
    const imp = await tx.bulkImport.findFirst({
      where: { id: importId, creatorId: tenantId },
      include: { errors: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!imp) throw new AppError('Import not found', 404);
    // BigInt ids are not JSON-serializable; convert to string
    return {
      ...imp,
      errors: imp.errors.map((e) => ({ ...e, id: e.id.toString() })),
    };
  });
}
