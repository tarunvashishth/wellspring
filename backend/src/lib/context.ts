import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  tenantId: string;
  requestId: string;
  ipAddress: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('Called outside request context');
  return ctx;
}

export function getPartialContext(): Partial<RequestContext> {
  return als.getStore() ?? {};
}
