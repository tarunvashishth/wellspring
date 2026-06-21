import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { getContext } from '../lib/context';
import { AppError } from '../lib/errors';
import { config } from '../config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantTx = Prisma.TransactionClient;

interface WithTenantOptions {
  timeout?: number;
  maxWait?: number;
}

export async function withTenant<T>(
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const { tenantId } = getContext();
  if (!UUID_RE.test(tenantId)) throw new AppError('Invalid tenant context', 500);

  return prisma.$transaction(
    async (tx) => {
      // SET LOCAL doesn't support $1 params or ::uuid casts. Use set_config() which
      // accepts a plain string value; the RLS function reads it back and casts to uuid.
      // tenantId is validated against UUID_RE above so interpolation is safe.
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${tenantId}', true)`);
      return fn(tx);
    },
    {
      timeout: options.timeout ?? 10_000,
      maxWait: options.maxWait ?? 5_000,
    },
  );
}

export async function withTenantForImport<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(fn, {
    timeout: config.IMPORT_TX_TIMEOUT_MS,
    maxWait: config.IMPORT_TX_MAX_WAIT_MS,
  });
}
