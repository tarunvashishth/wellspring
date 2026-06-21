# Session 03 — QA and Bug Fixes
**Tool:** Claude Code (claude-sonnet-4-6)  
**Date:** 2026-06-21  
**Purpose:** Live QA of running application, finding and fixing bugs

## Prompt

> /qa

## QA Flow

AI drove a headless browser (via gstack browse tool) through all application flows while simultaneously watching backend logs and network responses. 4 critical bugs were found and fixed with atomic commits.

## Bugs Found

### BUG-01: CORS missing
**How found:** Browser console showed "Access to fetch at 'http://localhost:4001/auth/signup' from origin 'http://localhost:4000' has been blocked by CORS policy"  
**Fix:** Added `cors` package, `app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:4000', credentials: true }))` before other middleware  
**Why this happened:** CORS was never added to the Express app. The frontend and backend run on different ports in development, so every request was blocked.

### BUG-02: SET LOCAL $1 syntax error
**How found:** Backend logs showed `ERROR: syntax error at or near "$1"` (Prisma P2010) on every program create/list request  
**Fix:** Changed from Prisma tagged template `$executeRaw` to `$executeRawUnsafe` with interpolated string  
**Why this happened:** PostgreSQL's `SET LOCAL` command doesn't accept parameterized values ($1). Prisma's tagged template always generates parameterized SQL.

### BUG-03: SET LOCAL ::uuid cast syntax error  
**How found:** Backend logs showed `ERROR: syntax error at or near "::"` after BUG-02 fix  
**Fix:** Changed to `SELECT set_config('app.current_tenant', tenantId, true)` — the function form accepts a plain string; the RLS function casts to uuid  
**Why this happened:** PostgreSQL's `SET LOCAL` only accepts bare values without type casts.

### BUG-04: Redis retry backoff = 6s per request
**How found:** All API calls took 5–8 seconds despite 51ms DB round trips  
**Root cause:** ioredis `maxRetriesPerRequest: 3` + 2s exponential backoff = 6s per call when Redis unavailable  
**Fix:** `maxRetriesPerRequest: 0`, `connectTimeout: 500`, `commandTimeout: 500`  
**Why this matters:** Redis is unavailable in dev; every authenticated request hits `isTokenDenylisted()` which was waiting 6s to fail.

## What I Directed AI to Do Differently

- When AI suggested "let's just start a Redis server" to avoid the timeout issue — I rejected this. The correct fix is to make the denylist fail fast, not to mandate Redis in dev. The fail-open pattern already existed; the retry count just needed fixing.
- When AI suggested investigating pino-pretty as the cause of slow responses — I directed it back to timing the Redis call specifically, which was the actual cause.

## Flows Verified Working

- Signup → redirect to /programs ✅
- Login (valid + invalid error state) ✅  
- Create program ✅
- Create session ✅
- Audit log with action filter ✅
- Sign out → redirect to /login ✅

## Flows Not Tested (infrastructure not available in dev)

- S3 upload flow (MinIO not running)
- CSV import end-to-end (tested API directly, not UI)
- Drag-to-reorder (requires browser drag events; tested API endpoint directly)
