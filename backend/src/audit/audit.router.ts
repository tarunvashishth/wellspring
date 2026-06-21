import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware';
import { listAuditLogs } from './audit.service';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        action: z.string().optional(),
        targetType: z.string().optional(),
        severity: z.enum(['info', 'warn', 'critical']).optional(),
      })
      .parse(req.query);

    res.json(await listAuditLogs(query));
  } catch (err) {
    next(err);
  }
});

export default router;
