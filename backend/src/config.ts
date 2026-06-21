import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  DATABASE_URL: z.string().url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).default(10),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32),
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_BUCKET: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  AWS_ENDPOINT: z.string().url().optional(),

  MAX_PROGRAMS_PER_CREATOR: z.coerce.number().int().min(1).default(50),
  MAX_SESSIONS_PER_PROGRAM: z.coerce.number().int().min(1).default(500),

  UPLOAD_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  UPLOAD_MAX_BYTES: z.coerce.number().int().default(524_288_000), // 500 MB

  IMPORT_TX_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  IMPORT_TX_MAX_WAIT_MS: z.coerce.number().int().default(30_000),
  IMPORT_STUCK_PENDING_MS: z.coerce.number().int().default(300_000),
  IMPORT_STUCK_PROCESSING_MS: z.coerce.number().int().default(600_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
