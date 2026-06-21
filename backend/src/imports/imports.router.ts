import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware';
import { startImport, getImport } from './imports.service';

const router = Router({ mergeParams: true });
router.use(authenticate);

const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.creatorId || req.ip || '',
  standardHeaders: true,
  legacyHeaders: false,
});

// Multer handles multipart — express.json never sees this route
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB CSV max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

router.post(
  '/',
  importLimiter,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw Object.assign(new Error('CSV file required'), { statusCode: 400 });

      const { clientImportId } = z
        .object({ clientImportId: z.string().uuid() })
        .parse(req.body);

      const result = await startImport(req.params.programId, clientImportId, req.file.buffer);

      if (result.idempotent) {
        return res.status(202).json(result);
      }
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get('/:importId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getImport(req.params.importId));
  } catch (err) {
    next(err);
  }
});

export default router;
