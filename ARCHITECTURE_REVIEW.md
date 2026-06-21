# Architecture Review

This document is written for the evaluator, not as marketing copy. It covers what was built, the reasoning behind the non-obvious decisions, what was deliberately left out, where the design has real weaknesses, and what would change in a production system with more time.

---

## What Was Built

A multi-tenant REST API (Express + TypeScript + PostgreSQL) with a Next.js frontend, covering:

- Creator auth (signup, login, logout, password reset)
- Program and session CRUD with ordered positions
- CSV bulk import with row-level validation and idempotency
- S3 presigned upload flow with inline content verification
- Per-tenant audit logging with cursor-based pagination
- Drag-to-reorder session UI (dnd-kit, optimistic updates)
- Audit log UI with filter, infinite scroll, URL-as-state

The backend is a single Express process. There is no message queue, no background worker, no caching layer beyond Redis (used only for the JWT denylist), and no CDN. The frontend is a Next.js App Router application using React Query for data fetching.

---

## What Was Skipped

**Email delivery.** Password reset generates a raw token and logs it to the console. In production this needs a transactional email provider (Postmark, Resend). The `requestPasswordReset` function is already wired to return the raw token; the only missing piece is the send call.

**Lambda / async content verification.** The upload flow does inline magic-byte checking — fetching the first 16 bytes from S3 at `/complete` time. A real system would trigger a Lambda on the S3 `ObjectCreated` event to run deeper inspection: ffprobe for codec validation, ClamAV for virus scanning, resolution and bitrate checks. The inline check is a meaningful improvement over nothing, but it is not a substitute.

**Webhook / polling for upload status.** After `/uploads/complete`, the UI gets a synchronous response. With async Lambda verification, the client would need to poll `GET /sessions/:id` or receive a webhook. The polling model is straightforward to add; the webhook model requires a `WebhookEndpoint` table, delivery guarantees, and retry logic.

**Streaming CSV processing.** The import route loads the entire CSV into memory (`multer.memoryStorage()`). For a 5 MB file at the current limit this is fine. For production imports that could be tens of megabytes, the parser should stream rows and process them in batches of ~500, each in its own transaction.

**Background import worker.** A large import currently holds a Prisma connection for up to `IMPORT_TX_TIMEOUT_MS` (120 seconds, configurable). Under five concurrent large imports, the entire connection pool is saturated and every other query — including login, program reads — queues or times out. The right fix is an outbox pattern: the API creates the `BulkImport` record and enqueues a job; a worker processes the CSV independently. This was designed but not implemented.

**Token refresh.** JWTs are 7-day fixed-expiry with no refresh flow. A user who sits down 6 days after login gets one more day of session before being forced to re-authenticate. Refresh tokens with short-lived access tokens is the correct production model.

**Rate limiting beyond login and import.** Only the login route (10/15min by email) and import route (20/hour by creator) are rate-limited. Program create, session create, and upload initiate are not. Under a credential-stuffing or scripted abuse scenario, these endpoints are exposed.

**Frontend auth guard.** The frontend redirect (`/` → `/login` or `/programs`) is client-side via `useEffect`. There is no middleware-level route protection. A logged-out user who navigates directly to `/programs` will see a flash of the page before being redirected. Next.js middleware with a cookie-based token check would fix this, but it requires moving the JWT from `localStorage` to an `HttpOnly` cookie.

**`HttpOnly` cookies for JWT storage.** The JWT is stored in `localStorage`. This is XSS-vulnerable. The correct approach is an `HttpOnly; Secure; SameSite=Strict` cookie, which is inaccessible to JavaScript. The tradeoff is that API clients (mobile, third-party) lose the ability to use the token directly; a separate API key system would be needed.

---

## Tenant Isolation Strategy

Every database operation that touches tenant data runs inside a Prisma interactive transaction that begins with:

```sql
SET LOCAL app.current_tenant = '<uuid>'::uuid
```

This sets a GUC (grand unified configuration variable) scoped to the current transaction. All RLS policies call `current_tenant_id()`, a `SECURITY DEFINER` function that reads this GUC:

```sql
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;
```

`NULLIF(..., '')` means a missing or empty GUC returns `NULL`. A `NULL` result from `current_tenant_id()` matches no rows — the policy fails closed. A misconfigured request sees zero rows, not all rows.

RLS is enabled with `FORCE ROW LEVEL SECURITY` on every tenant table, including for table owners. This prevents a privileged database role from accidentally bypassing policies.

**Why `SET LOCAL` and not connection-level `SET`.** `SET LOCAL` is scoped to the transaction. If the connection is returned to the pool while the GUC is still set, subsequent requests on that connection would inherit the previous tenant's context. `SET LOCAL` resets automatically at transaction end — the GUC cannot leak across pool connections.

**Defense in depth.** The application layer also filters by `creatorId` in every `updateMany`, `deleteMany`, and `findMany` call. RLS and the application-layer filter cover each other: a bug in one doesn't expose data.

**The composite FK.** Sessions have a foreign key on `(program_id, creator_id)` referencing `programs(id, creator_id)`. A session cannot reference a program belonging to a different creator at the database level, independent of RLS and independent of application code. This is the strongest guarantee — it is enforced by the database constraint engine, not by policy evaluation.

**What RLS does not protect against.** RLS is not a substitute for input validation. A creator can still send a `programId` that belongs to them but is unrelated to the session they're editing — that's a logical bug, not a tenant isolation bug. The `withTenant` wrapper ensures the GUC is always set before any tenant query runs; `getContext()` throws if called outside a request context, preventing accidental out-of-request GUC access.

---

## Bulk Import Design

The import system has two layers of idempotency and one race condition mitigation.

**Request-level idempotency.** The client generates a `clientImportId` UUID before sending the request. This UUID has a `UNIQUE` constraint on `bulk_imports`. If a network timeout causes the client to retry, the second request hits P2002 on the insert, catches it as `ConcurrentImportError`, and returns the first request's `importId` in a 202 response. The client gets a stable identifier regardless of which request landed.

**Row-level idempotency.** Each session row has an `importKey`: a SHA-256 hash of the title, stored in a partial unique index `(program_id, import_key) WHERE import_key IS NOT NULL`. Re-importing the same title does not create a duplicate session. The service pre-fetches existing import keys before `createMany` to identify which rows are new vs. already imported and reports them separately.

**Concurrent import serialization.** `resolveStartPosition` acquires a `SELECT FOR UPDATE` lock on the program row before computing `MAX(position)`. This serializes all concurrent imports targeting the same program. Without this lock, two imports computing `MAX(position)` at the same moment would compute the same base position, and their sessions would collide at commit time.

**The transaction length problem.** The main import transaction is the most vulnerable part of the system. A 10,000-row import with validation, position computation, and `createMany` can hold a connection for 60–90 seconds. With a pool of 10 connections, 10 concurrent large imports saturate the pool entirely. The timeout is configurable (`IMPORT_TX_TIMEOUT_MS`) but changing the number doesn't change the underlying problem — a long-running transaction is inherently a pool-exhaustion risk.

The correct fix is a background worker: insert the `BulkImport` record, return 202 with the `importId`, and process the rows in the background in batches of ~500, each in a short transaction. The client polls `GET /imports/:id` for status. This was not implemented within the scope of this project.

**Validation error path.** Row-level validation errors are written in a second, separate transaction after the main one commits. This is intentional: the error rows are informational and should not roll back the sessions that succeeded. The second transaction is best-effort — a failure to write error rows is logged but does not fail the import response.

---

## S3 Security

The upload flow never proxies bytes through the backend. The client uploads directly to S3 using a short-lived presigned POST URL. The backend issues the URL, enforces constraints via the POST policy, and verifies the result after upload completes.

**POST policy over presigned PUT.** Presigned PUT URLs accept any content-type and any size. POST policies support conditions that S3 enforces server-side:
- `content-length-range` — S3 rejects the upload if the file exceeds the limit (500 MB) regardless of what the client claims.
- Exact `Content-Type` match — the declared content type must match the policy exactly.
- `x-amz-server-side-encryption: AES256` — S3 will not accept the upload without server-side encryption.
- Metadata conditions — `x-amz-meta-creator-id` and `x-amz-meta-session-id` are required and must match what the backend set in the policy.

These conditions are enforced by S3 directly. A client that violates them gets a 403 from S3 before the backend is involved.

**Key structure.** Upload keys follow `uploads/<creatorId>/<sessionId>/<uuid>.<ext>`. The backend builds this key — the client never supplies a path. At `/complete`, the backend verifies `uploadKey.startsWith('uploads/${tenantId}/')` before reading the object. A creator cannot reference another creator's upload key because the path prefix check would fail.

**Magic-byte verification at `/complete`.** After upload, the backend issues a range GET for bytes 0–15 of the stored object and checks them against known audio/video magic byte signatures. This catches files with valid extensions and MIME types that contain different content — a PHP shell renamed to `.mp4` would fail here. On failure, the object is deleted from S3 before the error is returned.

**What the magic-byte check does not catch.** It verifies that the file starts with a known signature for the declared type. It does not validate that the file is a playable, well-formed media file. A truncated MP4 with a valid `ftyp` box would pass. Full validation requires parsing the container format, which is a job for ffprobe or a dedicated media processing service.

**Pending upload cleanup.** There is no job to clean up objects uploaded to S3 but never completed via `/uploads/complete`. A client that uploads to S3 and then crashes leaves an orphaned object. In production, an S3 lifecycle policy that deletes objects in the `uploads/` prefix after 24 hours handles this without application code.

---

## Areas of Uncertainty

**The DEFERRABLE INITIALLY DEFERRED constraint under concurrent load.** Session positions use a deferred unique constraint on `(program_id, position)`. This allows transient duplicates within a transaction, resolved at commit. The reorder service acquires `SELECT FOR UPDATE` on the program row to serialize concurrent writes. What is not fully analyzed is a scenario where three operations target the same program simultaneously: an import, a reorder, and a direct session create via the API. The lock acquisition order is not guaranteed to be consistent across these three paths, which could theoretically lead to a deadlock rather than a serialization. In practice, Postgres will detect and abort one of the transactions with a deadlock error, which the client would need to retry. This edge case was not stress-tested.

**`express.json` and Multer middleware ordering.** The import route intentionally has no `express.json` middleware — Multer handles the entire multipart request. This is verified at the route registration level in `app.ts`. What is not verified is whether a reverse proxy (nginx, ALB) upstream of the Express server reframes the multipart request in a way that changes its `Content-Type` header. If the `Content-Type` header is lost or altered, Multer would fail to parse the boundary and the request would be rejected with a 400. This is an infrastructure assumption that was not tested end-to-end with a real proxy.

**Redis failure behavior.** If Redis is unavailable, `isTokenDenylisted` throws. The current error handling in `verifyToken` does not distinguish a Redis failure from a denylisted token — both result in a 401. This means a Redis outage logs every user out. The correct behavior depends on the security posture: failing open (allowing tokens through if Redis is down) trades availability for security; failing closed (rejecting tokens if Redis is down) trades security for availability. The current implementation fails closed. This is probably correct for a wellness content platform, but it is a decision that should be explicit.

**Presigned POST URL replay.** The presigned POST URL is valid for `UPLOAD_EXPIRY_SECONDS` (default 300). A client that captures the URL and form fields during that window can upload a different file to the same key. The metadata conditions in the POST policy enforce the creator and session IDs, but they do not enforce the file content. The magic-byte check at `/complete` is the last line of defense against this. If a client initiates an upload, captures the presigned URL, and then calls `/complete` with a different upload, the session's `mediaKey` would point to the attacker's file rather than the intended one. The tenant key prefix check and metadata verification at `/complete` would still pass as long as the attacker used the same key. The magic-byte check is what catches this. This is a known gap in the design — it relies on the inline verification being correct, which the limitations above note is incomplete.

---

## Future Improvements

**Background import worker.** The most impactful change. Move CSV processing into a job queue (pg-boss is a good fit — it uses the existing Postgres connection, no new infrastructure). The API returns 202 immediately; the worker processes in batches of 500 rows per transaction. Eliminates the pool exhaustion risk and the 120-second transaction timeout.

**`HttpOnly` cookie for JWT storage.** Move the token from `localStorage` to a `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict` response header. The token becomes inaccessible to JavaScript, closing the XSS-to-session-theft path. Requires CORS reconfiguration and a separate token mechanism for non-browser clients.

**Async upload verification via S3 event → Lambda.** Replace the inline magic-byte check with an S3 event trigger. The Lambda runs ffprobe, a virus scanner, and resolution checks, then writes `mediaStatus` via an internal API call. The client polls for status. The inline check stays as a fast-fail for obvious non-media files, but the Lambda provides the real guarantee.

**Short-lived access tokens with refresh tokens.** Reduce JWT expiry to 15 minutes. Issue a 30-day refresh token stored in an `HttpOnly` cookie. The access token denylist in Redis becomes much smaller (entries expire in 15 minutes rather than 7 days). A compromise of an access token expires on its own in 15 minutes rather than requiring a Redis lookup for every request.

**Streaming CSV with per-batch transactions.** Parse the CSV as a stream, accumulate rows in batches of 500, and write each batch in its own short transaction. No single transaction holds a connection for more than a few seconds. Position computation runs once per batch rather than once per import.

**S3 lifecycle policy for unfinished uploads.** Add an S3 lifecycle rule: objects under the `uploads/` prefix that are older than 24 hours are deleted. Handles the case where a client uploads to S3 but never calls `/complete` — no application code needed.

**Frontend middleware-level auth guard.** Add a Next.js middleware file that checks for a token cookie and redirects to `/login` for unauthenticated requests. This requires moving from `localStorage` to a cookie. Eliminates the client-side redirect flash and prevents any SSR of authenticated pages for logged-out users.

**Connection pool sizing under import load.** The current configuration (`PRISMA_POOL_MAX=10`) gives imports and regular API requests the same pool. Under heavy import load, regular requests are starved. A proper fix is the background worker approach above. A partial mitigation without a worker is to run the backend as two processes with separate pools: one for API requests (small pool, fast queries) and one for imports (larger pool, long-running transactions). Express cluster mode can approximate this with a custom routing layer.
