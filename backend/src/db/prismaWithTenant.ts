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

// withTenant is the core of the multi-tenancy system — every DB write goes through here.
//
// How it works:
//  1. Gets the current user's ID (tenantId) from AsyncLocalStorage (set by auth middleware).
//  2. Validates it's a real UUID — prevents SQL injection since it's interpolated into raw SQL below.
//  3. Opens a Prisma transaction and runs two PostgreSQL commands inside it:
//     - SET LOCAL ROLE app_user: switches to a DB role that has Row Level Security (RLS) enabled.
//       The "owner" role bypasses RLS; app_user does not, so policies are enforced.
//     - set_config('app.current_tenant', ...): tells Postgres which tenant this query is for.
//       RLS policies on each table read this value and add a WHERE creatorId = current_tenant
//       filter automatically — even if the application code forgets to filter by user.
//  4. Runs the caller's function (fn) inside that transaction with the scoped DB client.
//
// Result: it's impossible for one user to accidentally read or write another user's data.
export async function withTenant<T>(
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const { tenantId } = getContext();
  if (!UUID_RE.test(tenantId)) throw new AppError('Invalid tenant context', 500);

  return prisma.$transaction(
    async (tx) => {
      // Switch to app_user (no BYPASSRLS) so RLS policies are enforced.
      // wellspring_owner has been granted app_user in the DB setup.
      // tenantId is UUID-validated above; set_config value is transaction-local.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${tenantId}', true)`);
      return fn(tx);
    },
    {
      timeout: options.timeout ?? 10_000,
      maxWait: options.maxWait ?? 5_000,
    },
  );
}

// Variant for bulk import operations — uses longer timeouts because importing many rows
// in a single transaction can take much longer than a normal request.
export async function withTenantForImport<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(fn, {
    timeout: config.IMPORT_TX_TIMEOUT_MS,
    maxWait: config.IMPORT_TX_MAX_WAIT_MS,
  });
}
