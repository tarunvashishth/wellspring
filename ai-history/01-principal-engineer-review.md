# Session 01 — Principal Engineer Review
**Tool:** Claude Code (claude-sonnet-4-6)  
**Date:** 2026-06-21  
**Purpose:** Pre-implementation review of architecture decisions

## Prompt

> Act as a principal engineer reviewing this project. Be brutally honest. Review the following 8 areas and list: 1. strengths 2. weaknesses 3. production risks 4. improvements. CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
> 
> Areas: tenant isolation strategy, auth implementation, bulk import design, S3 upload flow, session ordering concurrency, audit log design, ORM/DB layer, frontend architecture

## AI Response (summary)

The review covered 8 areas. Key findings:

**Strengths identified:**
- RLS with `SET LOCAL` GUC is the correct approach — scope-per-transaction avoids connection-level leakage
- Composite FK `(program_id, creator_id)` on sessions eliminates cross-tenant injection at DB level
- `DEFERRABLE INITIALLY DEFERRED` on position unique constraint is the right call for batch reorder
- `SELECT FOR UPDATE` on program row before position computation correctly serializes concurrent imports
- Magic-byte verification at `/complete` is meaningfully stronger than extension-only checks
- Denormalizing `creator_id` on `import_errors` eliminates the correlated subquery in RLS policy

**Weaknesses identified:**
- Dual ORM (Knex for auth, Prisma for everything else) — two connection pools, two migration sources, coordination risk
- Redis JWT denylist: `isTokenDenylisted` throws on Redis unavailable, logs every user out during Redis outage
- `express.json` applied globally — if multer runs after it, multipart body is already consumed
- `IMPORT_STUCK_PENDING_MS` hardcoded, not configurable
- `mediaStatus` permanently stuck at PROCESSING if Lambda never fires (no inline verification)
- `creator_id` correlated subquery in import_errors RLS policy

**Production risks:**
- Knex+Prisma dual pool: schema drift possible, connection exhaustion under load
- Redis fail-closed behavior: outage = all authenticated users logged out
- Import transaction length: 120s timeout, pool exhaustion under concurrent large imports
- Magic-byte gap: mediaStatus stuck at PROCESSING with no inline resolution path

## Decisions Made Based on Review

1. **Removed Knex entirely** — moved auth models (Creator, PasswordResetToken) into Prisma schema. Single ORM, single pool.
2. **Redis fail-open** — wrapped `isTokenDenylisted` in try/catch, return false on error. Denylist is best-effort.
3. **`express.json` scoped per-route** — imports route has NO jsonBody middleware; multer handles multipart.
4. **Inline magic-byte verification** — added `/uploads/lib/magic-bytes.ts`, Range GET of bytes 0–15 at `/complete`.
5. **`creator_id` denormalized on `import_errors`** — eliminates correlated subquery.
6. **Import thresholds in config** — `IMPORT_STUCK_PENDING_MS`, `IMPORT_STUCK_PROCESSING_MS` env vars.

## What I Pushed Back On

- AI suggested adding a Lambda for async verification as the fix — I kept inline verification as the MVP approach and documented the Lambda path in ARCHITECTURE_REVIEW.md as the production evolution. Inline is sufficient and removes infrastructure dependency.
- AI suggested schema-per-tenant isolation — I kept RLS with GUC because it scales to 10,000 tenants without schema proliferation, and the SECURITY DEFINER function + FORCE ROW LEVEL SECURITY gives comparable guarantees.
