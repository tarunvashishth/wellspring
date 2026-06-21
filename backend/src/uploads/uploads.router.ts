import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware';
import { initiateUpload, completeUpload } from './uploads.service';

const router = Router();
router.use(authenticate);

const initiateSchema = z.object({
  sessionId: z.string().uuid(),
  contentType: z.string().min(1).max(255),
  filename: z.string().min(1).max(255),
});

const completeSchema = z.object({
  sessionId: z.string().uuid(),
  uploadKey: z.string().min(1).max(1024),
});

router.post('/initiate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, contentType, filename } = initiateSchema.parse(req.body);
    res.json(await initiateUpload(sessionId, contentType, filename));
  } catch (err) {
    next(err);
  }
});

router.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, uploadKey } = completeSchema.parse(req.body);
    res.json(await completeUpload(sessionId, uploadKey));
  } catch (err) {
    next(err);
  }
});

export default router;
