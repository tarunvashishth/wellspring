import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.service';
import { als } from '../lib/context';
import { AppError } from '../lib/errors';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      creatorId: string;
      jti: string;
      tokenExp: number;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('Missing authorization header', 401, 'UNAUTHORIZED'));
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token);
    req.creatorId = payload.sub;
    req.jti = payload.jti;
    req.tokenExp = payload.exp;

    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';

    als.run({ tenantId: payload.sub, requestId, ipAddress }, () => next());
  } catch (err) {
    next(err);
  }
}
