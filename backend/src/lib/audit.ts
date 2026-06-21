import { Prisma } from '@prisma/client';
import { getPartialContext } from './context';
import { logger } from './logger';

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
  tx: TxClient;
  creatorId: string;
  actorId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'critical';
}

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
