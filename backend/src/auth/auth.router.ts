import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { signup, login, logout, requestPasswordReset, resetPassword } from './auth.service';
import { authenticate } from './auth.middleware';

// Express Router groups all /auth/* routes into one module.
// The router is mounted at /auth in app.ts, so POST /signup here becomes POST /auth/signup.
const router = Router();

// Rate limiter for the login route — max 10 attempts per email per 15 minutes.
// Keyed by email (not just IP) so attackers can't bypass it by rotating IPs.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body?.email as string) || req.ip || '',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

// Zod schemas validate and parse incoming request bodies before they reach service logic.
// .parse() throws a ZodError (caught by the global error handler) if the data is invalid,
// so service functions can trust their inputs are already clean.
const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(255).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/signup — creates a new account and returns a JWT token.
// 201 Created is the correct HTTP status for a newly created resource.
router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, displayName } = signupSchema.parse(req.body);
    const result = await signup(email, password, displayName);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /auth/login — validates credentials and returns a JWT token.
// loginLimiter middleware runs first to block brute-force attempts.
router.post('/login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout — revokes the current JWT by adding it to the Redis denylist.
// Requires authenticate middleware — you must be logged in to log out (provides the jti to revoke).
// 204 No Content = success with no response body.
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await logout(req.jti, req.tokenExp);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /auth/password-reset/request — step 1: generates a reset token and (in prod) emails it.
// Always responds with 202 regardless of whether the email exists to prevent email enumeration.
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

// POST /auth/password-reset/complete — step 2: validates the token and sets the new password.
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
