import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware';
import {
  listPrograms,
  getProgram,
  createProgram,
  updateProgram,
  deleteProgram,
} from './programs.service';

const router = Router();
// router.use(authenticate) applies the auth middleware to ALL routes in this file.
// No route here is publicly accessible \u2014 every request must carry a valid JWT.
router.use(authenticate);

// Regex that blocks invisible/dangerous Unicode characters in user text fields.
// Prevents attacks using zero-width characters, directional overrides (used in text spoofing),
// and control characters that could break downstream systems.
const SAFE_TEXT_RE = /^[^\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2028-\u2029]+$/;

const tagSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(SAFE_TEXT_RE, 'Tag contains invalid characters');

// Zod schemas define the exact shape and constraints of valid request bodies.
// .parse() throws a ZodError (caught by global error handler) for any invalid input,
// so service functions receive only clean, validated data.
const createSchema = z.object({
  title: z.string().min(1).max(255).regex(SAFE_TEXT_RE),
  description: z.string().max(2000).optional(),
  tags: z.array(tagSchema).max(20).default([]),
});

// .partial() makes all fields of createSchema optional \u2014 allows partial updates (PATCH semantics).
const updateSchema = createSchema.partial();

// GET /programs \u2014 list all programs for the current user
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listPrograms());
  } catch (err) {
    next(err);
  }
});

// POST /programs \u2014 create a new program
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createSchema.parse(req.body);
    res.status(201).json(await createProgram(data));
  } catch (err) {
    next(err);
  }
});

// GET /programs/:id \u2014 fetch a single program by its UUID
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getProgram(req.params.id));
  } catch (err) {
    next(err);
  }
});

// PATCH /programs/:id \u2014 partially update a program (only send the fields you want to change)
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateSchema.parse(req.body);
    res.json(await updateProgram(req.params.id, data));
  } catch (err) {
    next(err);
  }
});

// DELETE /programs/:id \u2014 delete a program (cascades to all its sessions and media)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteProgram(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
