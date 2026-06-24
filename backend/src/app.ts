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

// app.ts is the Express application factory — it wires together all middleware and routers.
// server.ts imports this and calls .listen(). Keeping them separate makes the app
// easier to test (you can import app without starting a server).
const app = express();

// CORS (Cross-Origin Resource Sharing) — browsers block requests from one origin to another
// by default. This middleware adds the headers that tell browsers to allow our frontend to
// call our API. credentials:true is needed to allow the Authorization header to be sent.
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:4000',
  credentials: true,
}));

// Request logging with pino-http — logs every request and response automatically.
// customProps injects per-request context from AsyncLocalStorage into each log line so
// every log entry is tagged with which user made the request and which request ID it belongs to.
// This is essential for debugging production issues ("show me all logs for request abc123").
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

// express.json() is intentionally NOT applied globally — only to JSON routes.
// If it were global, it would try to parse the multipart/form-data body of CSV uploads
// before multer gets a chance to handle it, corrupting the request.
const jsonBody = express.json({ limit: '100kb' });

// Health check — no auth, no body parsing. Used by load balancers to check if the server is alive.
app.use('/health', healthRouter);

// Auth routes need JSON body
app.use('/auth', jsonBody, authRouter);

// Programs — JSON body. Note: /programs/:id/sessions and /programs/:id/imports are
// mounted separately below so their specific middleware applies only to those paths.
app.use('/programs', jsonBody, programsRouter);

// Sessions are nested under programs in the URL. :programId is accessible in session handlers
// via req.params.programId (Express mergeParams must be enabled in the sessions router).
app.use('/programs/:programId/sessions', jsonBody, sessionsRouter);

// Imports use multipart/form-data (file upload) — multer handles parsing, no express.json needed.
app.use('/programs/:programId/imports', importsRouter);

app.use('/uploads', jsonBody, uploadsRouter);
app.use('/audit', jsonBody, auditRouter);

// Global error handler — Express recognizes a 4-argument middleware as an error handler.
// All routes call next(err) to reach here. This is the single place that formats errors
// into consistent JSON responses so every error looks the same to the frontend.
//
// Error priority:
//  1. ZodError (validation) → 400 with field-level details
//  2. AppError (our custom errors) → the status code we chose (404, 409, 422 etc.)
//  3. Any other thrown error with a statusCode → pass it through
//  4. Unexpected errors → 500 Internal Server Error (never leak stack traces)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    // .flatten().fieldErrors produces a clean { fieldName: ["error message"] } object
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

  // Log unexpected errors with full details (stack trace etc.) but only return a
  // generic message to the client — never expose internal error details in production.
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
