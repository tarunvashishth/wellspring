import { Prisma } from '@prisma/client';
import { getPartialContext } from './context';
import { logger } from './logger';

// Exhaustive union type of every auditable action in the system.
// Using a union type (instead of plain string) means TypeScript will catch typos at compile time —
// if you write 'program.crate' instead of 'program.create', the compiler errors immediately.
export type AuditAction =
  | 'creator.signup'
  | 'creator.login'
  | 'creator.logout'
  | 'creator.password_reset_request'
  | 'creator.password_reset_complete'
  | 'program.create'
  | 'program.update'
  | 'program.delete'
  | 'session.create'
  | 'session.update'
  | 'session.delete'
  | 'session.reorder'
  | 'import.start'
  | 'import.complete'
  | 'upload.initiate'
  | 'upload.complete'
  | 'upload.fail';

type TxClient = Prisma.TransactionClient;

interface WriteAuditParams {
  tx: TxClient;         // must be inside a transaction so the audit log is atomic with the data write
  creatorId: string;    // the user who owns the data being changed (for RLS scoping)
  actorId: string;      // the user who performed the action (same as creatorId today; differs in future admin features)
  action: AuditAction;
  targetType: string;   // what kind of thing was changed (e.g. 'program', 'session')
  targetId?: string;    // the specific record's ID
  metadata?: Record<string, unknown>; // any extra details (e.g. { sessionCount: 5 } for reorder)
  severity?: 'info' | 'warn' | 'critical';
}

// writeAudit is used inside withTenant transactions — the audit row is written in the same
// DB transaction as the data change. If the transaction rolls back, the audit row also disappears.
// This guarantees the audit log never records an action that didn't actually happen.
// requestId and ipAddress are pulled from AsyncLocalStorage (set by auth middleware) — no need
// to pass them through every function call.
export async function writeAudit({
  tx,
  creatorId,
  actorId,
  action,
  targetType,
  targetId,
  metadata,
  severity = 'info',
}: WriteAuditParams): Promise<void> {
  const { requestId, ipAddress } = getPartialContext();
  await tx.auditLog.create({
    data: {
      creatorId,
      actorId,
      action,
      targetType,
      targetId,
      metadata: metadata as Prisma.InputJsonValue,
      severity,
      requestId,
      ipAddress,
    },
  });
}

interface WriteSecurityAuditParams {
  prisma: { auditLog: { create: (args: { data: Prisma.AuditLogCreateInput }) => Promise<unknown> } };
  creatorId: string;
  actorId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'critical';
}

// writeSecurityAudit is the out-of-transaction version used for auth events (login, signup, logout).
// Auth events happen outside withTenant because no tenant context exists yet (the user isn't logged in).
// It wraps the write in a try/catch so a failed audit write NEVER blocks the auth response —
// it's better to log an error and let the user log in than to crash the login endpoint.
export async function writeSecurityAudit(params: WriteSecurityAuditParams): Promise<void> {
  const { requestId, ipAddress } = getPartialContext();
  try {
    await params.prisma.auditLog.create({
      data: {
        creatorId: params.creatorId,
        actorId: params.actorId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        metadata: params.metadata as Prisma.InputJsonValue,
        severity: params.severity ?? 'info',
        requestId,
        ipAddress,
      },
    });
  } catch (err) {
    logger.error({ err }, 'security audit write failed (best-effort)');
  }
}
