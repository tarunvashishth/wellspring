import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { AppError } from './lib/errors';
import { getPartialContext } from './lib/context';

import healthRouter from './health/health.router';
import authRouter from './auth/auth.router';
import programsRouter from './programs/programs.router';
import sessionsRouter from './sessions/sessions.router';
import importsRouter from './imports/imports.router';
import uploadsRouter from './uploads/uploads.router';
import auditRouter from './audit/audit.router';

const app = express();

// CORS — allow frontend dev server and any configured origin
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:4000',
  credentials: true,
}));

// Request logging — inject tenant_id and request_id from AsyncLocalStorage into every log line
app.use(pinoHttp({
  logger,
  customProps: (_req, _res) => {
    const ctx = getPartialContext();
    return {
      tenant_id: ctx?.tenantId ?? null,
      request_id: ctx?.requestId ?? null,
    };
  },
}));

// Body parsing — scoped to JSON routes only.
// express.json is NOT applied globally so that multer-handled multipart
// routes (POST /programs/:id/imports) never have their body parsed here first.
const jsonBody = express.json({ limit: '100kb' });

app.use('/health', healthRouter);

// Auth routes need JSON body
app.use('/auth', jsonBody, authRouter);

// API routes — JSON body except imports (multipart)
app.use('/programs', jsonBody, programsRouter);

// Sessions nested under programs
app.use('/programs/:programId/sessions', jsonBody, sessionsRouter);

// Imports: NO jsonBody — multer handles the entire request
app.use('/programs/:programId/imports', importsRouter);

app.use('/uploads', jsonBody, uploadsRouter);
app.use('/audit', jsonBody, auditRouter);

// Global error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation error',
      details: err.flatten().fieldErrors,
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }

  if ((err as { statusCode?: number }).statusCode) {
    const e = err as { statusCode: number; message: string };
    return res.status(e.statusCode).json({ error: e.message });
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
