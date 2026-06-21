import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware';
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  reorderSessions,
} from './sessions.service';

const router = Router({ mergeParams: true });
router.use(authenticate);

const durationSchema = z
  .string()
  .regex(/^\d+$/, 'Must be a positive integer')
  .transform(Number)
  .pipe(z.number().int().min(1).max(86_400));

const createSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  instructorName: z.string().max(255).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  durationSeconds: z.union([durationSchema, z.number().int().min(1).max(86_400)]),
});

const updateSchema = createSchema.partial();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listSessions(req.params.programId));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createSchema.parse(req.body);
    res.status(201).json(await createSession(req.params.programId, data));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getSession(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateSchema.parse(req.body);
    res.json(await updateSession(req.params.id, data));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteSession(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.put('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderedIds } = z.object({ orderedIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
    res.json(await reorderSessions(req.params.programId, orderedIds));
  } catch (err) {
    next(err);
  }
});

export default router;
