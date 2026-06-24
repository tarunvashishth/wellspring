import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.service';
import { als } from '../lib/context';
import { AppError } from '../lib/errors';
import { randomUUID } from 'crypto';

// Extends Express's built-in Request type so TypeScript knows these fields exist
// after the authenticate middleware runs. Routes that use authenticate can safely
// access req.creatorId, req.jti, and req.tokenExp without type errors.
declare global {
  namespace Express {
    interface Request {
      creatorId: string; // the logged-in user's ID (from JWT sub claim)
      jti: string;       // unique token ID (used to revoke the token on logout)
      tokenExp: number;  // token expiry unix timestamp (used to calculate Redis TTL)
    }
  }
}

// Middleware that protects routes — must run before any handler that needs a logged-in user.
// Flow: extract token from header → verify signature + expiry + denylist → attach user info to req.
// Calls next(error) on failure so the global error handler returns a consistent 401 response.
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  // Tokens are sent as "Bearer <token>" — reject anything that doesn't match this format.
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('Missing authorization header', 401, 'UNAUTHORIZED'));
  }

  // slice(7) strips the "Bearer " prefix (7 characters) to get the raw token string.
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token);
    // Attach decoded values to req so downstream route handlers can use them without
    // re-parsing the token.
    req.creatorId = payload.sub;
    req.jti = payload.jti;
    req.tokenExp = payload.exp;

    // requestId: use client-supplied ID if present (for distributed tracing), otherwise generate one.
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    // x-forwarded-for is set by load balancers/proxies; split(',')[0] gets the original client IP.
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';

    // AsyncLocalStorage (als) stores per-request context (tenantId, requestId, ipAddress) so any
    // code deeper in the call stack can read it without threading it through function arguments.
    // This is how audit logs automatically know which user made a request.
    als.run({ tenantId: payload.sub, requestId, ipAddress }, () => next());
  } catch (err) {
    next(err);
  }
}
