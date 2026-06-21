import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { signup, login, logout, requestPasswordReset, resetPassword } from './auth.service';
import { authenticate } from './auth.middleware';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body?.email as string) || req.ip || '',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(255).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, displayName } = signupSchema.parse(req.body);
    const result = await signup(email, password, displayName);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await logout(req.jti, req.tokenExp);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post(
  '/password-reset/request',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      await requestPasswordReset(email);
      // Always 202 to prevent email enumeration
      res.status(202).json({ message: 'If that email exists, a reset link has been sent' });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/password-reset/complete',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = z
        .object({ token: z.string().min(1), password: z.string().min(8).max(128) })
        .parse(req.body);
      await resetPassword(token, password);
      res.json({ message: 'Password reset successfully' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
