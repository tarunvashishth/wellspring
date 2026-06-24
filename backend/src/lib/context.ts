import { AsyncLocalStorage } from 'async_hooks';

// Per-request data that needs to be accessible anywhere in the call stack
// without passing it through every function argument.
export interface RequestContext {
  tenantId: string;   // the logged-in creator's ID — used by withTenant to scope DB queries
  requestId: string;  // unique ID for this HTTP request — used for tracing/logging
  ipAddress: string;  // client IP — recorded in audit logs
}

// AsyncLocalStorage is Node's built-in "thread-local storage" equivalent for async code.
// auth.middleware sets it once per request; any function called during that request can read it.
export const als = new AsyncLocalStorage<RequestContext>();

// Used inside service functions — throws if called outside a request (e.g. in a background job
// that forgot to set context), making the bug obvious rather than silently returning undefined.
export function getContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('Called outside request context');
  return ctx;
}

// Safe version for code that may run outside a request context (e.g. startup, health checks).
export function getPartialContext(): Partial<RequestContext> {
  return als.getStore() ?? {};
}
