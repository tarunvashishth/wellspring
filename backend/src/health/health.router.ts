import { Router, Request, Response } from 'express';
import { prisma } from '../db/prisma';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok' });
  } catch {
    res.status(503).json({ status: 'error', db: 'unavailable' });
  }
});

export default router;
