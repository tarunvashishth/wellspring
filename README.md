# Wellspring

> **Loom Walkthrough:** https://www.loom.com/share/92d12e330f3a49599144da94bf93011d

Multi-tenant content management platform for wellness creators. Built for the Breakthrough take-home assessment.

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, and MinIO (S3-compatible local storage).

### 2. Backend setup

```bash
cd backend
cp ../.env.example .env          # edit secrets if needed
npm install
npm run db:migrate               # run Prisma migrations
psql $DATABASE_URL -f prisma/migrations/001_init.sql   # apply RLS + policies
npm run db:seed                  # 2 creators × 3 programs × 10 sessions
npm run dev                      # starts on http://localhost:3001
```

### 3. Frontend setup

```bash
cd frontend
npm install
cp ../.env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:3001
npm run dev                      # starts on http://localhost:3000
```

Open http://localhost:3000 and log in with:

| Email | Password |
|---|---|
| alice@example.com | Password123! |
| bob@example.com | Password123! |

---

## Architecture

### Multi-tenancy
Every request sets `app.current_tenant` as a PostgreSQL GUC inside a transaction. All tables have Row-Level Security policies using `current_tenant_id()`, which returns NULL if the GUC is unset — failing closed. The composite FK `(program_id, creator_id) → programs(id, creator_id)` on sessions enforces cross-tenant isolation at the database level as a second layer.

### Auth
bcrypt + JWT (HS256). Logout revokes the JTI in Redis with a TTL matching the token expiry (self-pruning). No in-memory state — works correctly in multi-instance deployments.

### Uploads
Presigned S3 POST → client uploads directly to S3 → client calls `/uploads/complete` → backend fetches first 16 bytes from S3, checks magic bytes against declared content type → sets `mediaStatus = VERIFIED`. Five independent security layers between the client and a stored file.

### CSV Import
`clientImportId` UUID provides request-level idempotency (UNIQUE constraint). `importKey` (SHA-256 of title) provides row-level idempotency. `SELECT FOR UPDATE` on the program row serializes concurrent imports against each other and against session reorder.

### Audit Log
Written in the same transaction as the mutation — atomically or not at all. Security events (login, signup) are written out-of-transaction as best-effort.

---

## API Reference

### Auth
| Method | Path | Description |
|---|---|---|
| POST | /auth/signup | Create account |
| POST | /auth/login | Login |
| POST | /auth/logout | Revoke JWT |
| POST | /auth/password-reset/request | Send reset link |
| POST | /auth/password-reset/complete | Set new password |

### Programs
| Method | Path | Description |
|---|---|---|
| GET | /programs | List all programs |
| POST | /programs | Create program |
| GET | /programs/:id | Get program |
| PATCH | /programs/:id | Update program |
| DELETE | /programs/:id | Delete program |

### Sessions
| Method | Path | Description |
|---|---|---|
| GET | /programs/:id/sessions | List sessions |
| POST | /programs/:id/sessions | Create session |
| PATCH | /programs/:id/sessions/:sid | Update session |
| DELETE | /programs/:id/sessions/:sid | Delete session |
| PUT | /programs/:id/sessions/reorder | Reorder sessions |

### Imports
| Method | Path | Description |
|---|---|---|
| POST | /programs/:id/imports | Upload CSV (multipart) |
| GET | /programs/:id/imports/:iid | Get import status |

### Uploads
| Method | Path | Description |
|---|---|---|
| POST | /uploads/initiate | Get presigned S3 URL |
| POST | /uploads/complete | Verify upload, set VERIFIED |

### Audit
| Method | Path | Description |
|---|---|---|
| GET | /audit | List logs (cursor-paginated) |

### Health
| Method | Path | Description |
|---|---|---|
| GET | /health | Liveness probe |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| DATABASE_URL | required | Postgres connection string |
| REDIS_URL | redis://localhost:6379 | Redis for JWT denylist |
| JWT_SECRET | required | ≥32 chars |
| AWS_BUCKET | required | S3 bucket name |
| AWS_ACCESS_KEY_ID | required | S3 credentials |
| AWS_SECRET_ACCESS_KEY | required | S3 credentials |
| AWS_ENDPOINT | — | Set for MinIO in dev |
| PRISMA_POOL_MAX | 10 | Prisma connection pool size |
| MAX_PROGRAMS_PER_CREATOR | 50 | Per-creator program limit |
| MAX_SESSIONS_PER_PROGRAM | 500 | Per-program session limit |
| UPLOAD_MAX_BYTES | 524288000 | 500 MB |
| IMPORT_TX_TIMEOUT_MS | 120000 | Import transaction timeout |
| IMPORT_STUCK_PENDING_MS | 300000 | When to retry a stuck PENDING import |
| IMPORT_STUCK_PROCESSING_MS | 600000 | When to retry a stuck PROCESSING import |

---

## Running Tests

```bash
cd backend
DATABASE_URL=postgresql://wellspring:wellspring@localhost:5432/wellspring \
DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:5432/wellspring \
npm test
```

Tests use a real PostgreSQL instance and verify RLS isolation end-to-end — mocking the DB would not prove RLS works.
